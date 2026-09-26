/**
 * @riceawa/dsh-lan-gateway — the LAN/internet gateway plugin for the
 * DeepSeek Harness web GUI.
 *
 * dsh's web CLI hard-refuses `--host 0.0.0.0` (exposing remote code execution
 * to the network), so this plugin leaves dsh bound to 127.0.0.1 and starts its
 * own reverse-proxy gateway on the unspecified address — both families, so
 * IPv6 clients reach it too — that forwards to the loopback dsh port,
 * rewriting Host/Origin so the request reaches the dsh web server as if it came
 * from the loopback authority it names.
 *
 * Security model (default-deny, post-QVD-2026-57410):
 * - Every source — loopback, LAN, internet — must present a gateway session
 *   before anything is forwarded. Classification by source IP grants nothing.
 *   `lanPasswordless` is an explicit opt-in (false by default) that lets
 *   LAN/loopback sources skip the gateway login; it is refused unless the dsh
 *   base itself enforces browser-session auth (auto-detected in-process), so a
 *   "trust my LAN" choice can never reinstall the original Host-trust hole.
 * - Against such a base the gateway relays one shared upstream session (see
 *   `upstream-session.ts`), so dsh's own authorization still gates every
 *   request: the gateway only decides who may ride its shared session.
 * - The listener refuses to run over plaintext unless TLS, a declared trusted
 *   TLS-terminating proxy, or an explicit `allowInsecurePlaintext` opt-in is
 *   present.
 * - The gateway never relays its own surface (`/lan-gateway/*`, the login and
 *   logout pages). Sessions are revocable: each carries a random id, so signing
 *   out retires that one session and the WebSockets it opened, and each carries
 *   a revocation epoch, so a password change or secret rotation kills every
 *   session at once.
 *
 * Every tunable is also exposed as the `lan-gateway` user-settings namespace
 * (`ctx.settings`), so the official DSH Settings → Plugins page can adjust
 * port, CIDRs, auth, and TLS live; the running listener restarts on change.
 * The card reads/writes through the loopback-only `/lan-gateway/config` route;
 * remote browsers get a 403 from the gateway for that prefix and manage the
 * gateway through the `lan_gateway` tool instead.
 *
 * Disabled by default in the bundle patch (safe): the listener opens only
 * after `lan_gateway enable` or `enabled: true`.
 *
 * @module @riceawa/dsh-lan-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import z from '@deepseek-ai/schemastery'
// Type-only: the `settings` service (0.1.7 addresses a write by profile entry
// id) and the Loader's `fiber.entry`, which is where this plugin reads its own
// entry id from.
import type SettingsService from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { DEFAULT_LAN_CIDR_STRINGS, originMatchesHost } from './auth.ts'
import {
  CONFIG_FIELD_KEYS,
  OPTIONAL_CONFIG_KEYS,
} from './config-fields.ts'
import { LanGateway } from './gateway.ts'
import { readBody } from './login.ts'
import {
  isLoopbackHost,
  READ_ONLY_METHODS,
} from './request-policy.ts'
import {
  loadState,
  saveState,
  setPassword,
  type GatewayState,
} from './state.ts'
import {
  describeCert,
  loadOrRenewSelfSigned,
  loadCustomCert,
  parseSelfSignedHosts,
  readSelfSignedStatus,
  regenerateSelfSigned,
  type TlsMaterial,
} from './tls.ts'
import { lanGatewayTool } from './tool.ts'
import { UpstreamSessionRelay, type UpstreamSession } from './upstream-session.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-lan-gateway'

/** Requires the web server service (binds before this row's apply runs) and the tool registry. */
export const inject = ['webServer', 'tools']

/** Minimal surface of the dsh web server service this plugin reads. */
export interface WebServerSurface {
  port: number
  /** Register an exact/prefix HTTP route owned by this plugin. */
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Minimal surface of the dsh client-connection service (session-capable bases). */
export interface UpstreamConnectionSurface {
  /** A root URL for the upstream origin carrying the process launch token. */
  authenticatedUrl(baseUrl: string): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServerSurface
    connection: UpstreamConnectionSurface
  }
}

/** One command result returned to the model. */
export interface ToolResult {
  ok: boolean
  message: string
}

/** The runtime surface the management tool drives. Implemented by `apply`. */
export interface GatewayController {
  status(): ToolResult
  enable(): Promise<ToolResult>
  disable(): Promise<ToolResult>
  setPassword(password: string | undefined): Promise<ToolResult>
  rotateSecret(): ToolResult
  regenerateTls(): Promise<ToolResult>
}

/** Deployment configuration (composition-level; secrets live in state.json). */
export interface Config {
  /** Whether the gateway listener is started at boot. Default false (safe). */
  enabled: boolean
  /** Port to bind on the unspecified address, both address families. */
  gatewayPort: number
  /** Explicit dsh target port; defaults to the live `ctx.webServer.port`. */
  dshTargetPort?: number
  /** LAN CIDRs that may be treated as trusted when `lanPasswordless` is on. */
  lanCidrs: string[]
  /**
   * Opt-in (default false): let LAN/loopback sources skip the gateway login.
   * Only allowed against a session-capable dsh base, where upstream auth still
   * gates every request via the relayed shared session.
   */
  lanPasswordless: boolean
  /**
   * Removed capability: authentication is always required. Retained only so an
   * explicit legacy `authRequired: false` is rejected loudly instead of
   * silently ignored. Not card-editable and never written back to the user
   * section — the config route builds its patch from the editable key set.
   */
  authRequired?: boolean
  /** Session cookie lifetime in days. */
  cookieMaxAgeDays: number
  /**
   * Cookie name. Deliberately not card-editable — see the editable key set in
   * `config-fields.ts`; the config route applies a patch, so an operator's
   * custom name survives every save from the Settings card.
   */
  cookieName: string
  /** Whether the gateway listener speaks TLS. */
  tlsEnabled: boolean
  /** Certificate source: auto-generated self-signed, or user-supplied files. */
  tlsMode: 'self-signed' | 'custom'
  /** Custom mode: path to the PEM certificate (or chain). */
  tlsCertPath?: string
  /** Custom mode: path to the PEM private key. */
  tlsKeyPath?: string
  /**
   * Self-signed mode: comma/space separated DNS names and IPs for the SANs.
   *
   * Read when a certificate is generated, not when it is served: changing it
   * does not replace a certificate that already exists and is still valid. Use
   * `lan_gateway tls-regenerate` for that.
   */
  tlsSelfSignedHosts?: string
  /**
   * Self-signed certificate validity in days (default 825 ≈ 27 months).
   *
   * 825 is the ceiling Apple states for TLS server certificates, and the
   * well-known 398-day limit — which this default is sometimes mistaken for
   * exceeding — applies only to certificates chaining to a root preinstalled
   * by the platform: Apple exempts user- and administrator-added roots
   * outright, and a self-signed certificate is always one of those. Since a
   * self-signed certificate is either clicked through or trusted by hand,
   * there is nothing to gain from the shorter window and a re-trust to lose
   * every time it lapses.
   *
   * Like `tlsSelfSignedHosts`, this applies to the next generation only.
   */
  tlsCertMaxAgeDays: number
  /**
   * Escape hatch (default false): permit plaintext HTTP. Never derived from
   * `X-Forwarded-Proto` — the operator declares it.
   */
  allowInsecurePlaintext: boolean
  /**
   * An identifier for a trusted TLS-terminating proxy in front of the gateway.
   * Declaring one marks the ingress encrypted (Secure cookies, passes the
   * encrypted-ingress gate) without this listener sending HSTS.
   *
   * Note the coupling with login rate limiting: the limiter is keyed by
   * `socket.remoteAddress`, and `X-Forwarded-For` is deliberately untrusted, so
   * behind such a proxy every browser shares one bucket — the login budget
   * becomes per-deployment, not per-client.
   */
  trustedTerminator?: string
  /**
   * Explicit override for the session cookie's `Secure` attribute. Unset =
   * automatic: Secure when the gateway serves TLS itself or a
   * `trustedTerminator` is declared. Set `false` when the trusted proxy fronts
   * a plaintext browser ingress — browsers refuse to store a Secure cookie over
   * plain HTTP, so every login would bounce straight back to `/__login`.
   */
  secureCookies?: boolean
}

/** A `.volatile()` config field as the Loader hands it to `apply`. */
export interface ConfigRef<T> {
  /** The current value; updated in place when the profile entry is written. */
  get(): T
}

/**
 * The config object `apply` receives: dsh 0.1.7 hands every `.volatile()` field
 * over as a reference rather than a value, so the plugin reads its live config
 * through `readConfig`. A field declared optional and left unset resolves to
 * `undefined` instead of a reference, hence the union inside `ConfigRef`.
 */
export type ConfigRefs = { [K in keyof Required<Config>]: ConfigRef<Config[K]> }

/**
 * Schemastery configuration validated by the Loader.
 *
 * Every field is `.volatile()`, which is what lets the Settings service write
 * it: 0.1.7 projects only volatile fields into forms and refuses an edit to any
 * other path (`not volatile`). The mark also changes the runtime shape — a
 * volatile field arrives as a reference (see `ConfigRefs`), never as the plain
 * value the rest of this file expects — so read it through `readConfig`.
 */
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  gatewayPort: z.natural().min(1).max(65535).default(3081).volatile(),
  dshTargetPort: z.natural().min(1).max(65535).volatile(),
  lanCidrs: z.array(String).default([...DEFAULT_LAN_CIDR_STRINGS]).volatile(),
  lanPasswordless: z.boolean().default(false).volatile(),
  authRequired: z.boolean().default(true).volatile(),
  cookieMaxAgeDays: z.natural().min(1).max(365).default(7).volatile(),
  cookieName: z.string().default('dsh_gw_auth').volatile(),
  tlsEnabled: z.boolean().default(false).volatile(),
  tlsMode: z.union([z.const('self-signed'), z.const('custom')]).default('self-signed').volatile(),
  tlsCertPath: z.string().volatile(),
  tlsKeyPath: z.string().volatile(),
  tlsSelfSignedHosts: z.string().default('localhost').volatile(),
  tlsCertMaxAgeDays: z.natural().min(1).max(3650).default(825).volatile(),
  allowInsecurePlaintext: z.boolean().default(false).volatile(),
  trustedTerminator: z.string().volatile(),
  secureCookies: z.boolean().volatile(),
})

/**
 * Unwrap the config references into the plain values every other function in
 * this file reads. Called on each access rather than once, because a settings
 * write updates the references in place.
 * @param refs - the config object handed to `apply`.
 * @returns one detached plain snapshot.
 */
export function readConfig(refs: ConfigRefs): Config {
  const dshTargetPort = refs.dshTargetPort?.get()
  const authRequired = refs.authRequired?.get()
  const tlsCertPath = refs.tlsCertPath?.get()
  const tlsKeyPath = refs.tlsKeyPath?.get()
  const tlsSelfSignedHosts = refs.tlsSelfSignedHosts?.get()
  const trustedTerminator = refs.trustedTerminator?.get()
  const secureCookies = refs.secureCookies?.get()
  return {
    enabled: refs.enabled.get(),
    gatewayPort: refs.gatewayPort.get(),
    lanCidrs: [...refs.lanCidrs.get()],
    lanPasswordless: refs.lanPasswordless.get(),
    cookieMaxAgeDays: refs.cookieMaxAgeDays.get(),
    cookieName: refs.cookieName.get(),
    tlsEnabled: refs.tlsEnabled.get(),
    tlsMode: refs.tlsMode.get(),
    tlsCertMaxAgeDays: refs.tlsCertMaxAgeDays.get(),
    allowInsecurePlaintext: refs.allowInsecurePlaintext.get(),
    // `exactOptionalPropertyTypes` is on, so an absent optional key must stay
    // absent rather than be assigned `undefined`. Every field here has a schema
    // default or is genuinely optional, so an absent reference means unset.
    ...(dshTargetPort !== undefined ? { dshTargetPort } : {}),
    ...(authRequired !== undefined ? { authRequired } : {}),
    ...(tlsCertPath !== undefined ? { tlsCertPath } : {}),
    ...(tlsKeyPath !== undefined ? { tlsKeyPath } : {}),
    ...(tlsSelfSignedHosts !== undefined ? { tlsSelfSignedHosts } : {}),
    ...(trustedTerminator !== undefined ? { trustedTerminator } : {}),
    ...(secureCookies !== undefined ? { secureCookies } : {}),
  }
}

/**
 * Build the reference-shaped config `apply` receives, exactly as the Loader
 * builds it. Exported for tests that drive `apply` directly.
 * @param raw - a config object; missing fields take their schema defaults.
 * @returns one reference per volatile field.
 */
export function configRefs(raw: object): ConfigRefs {
  return Config(raw) as unknown as ConfigRefs
}

/**
 * Validate a raw config object the way the Loader does, and unwrap it.
 *
 * `Config` marks every field volatile, so a validation hands the values back as
 * references (typed deeply-readonly by schemastery); this returns the plain
 * shape the rest of the file reads. Used to judge a config the Settings card is
 * about to save, before it is persisted.
 * @param raw - a config object; missing fields take their schema defaults.
 * @returns the validated plain config.
 */
export function validateConfig(raw: object): Config {
  return readConfig(configRefs(raw))
}

/** Facts the fail-closed start guard needs to judge a config. */
export interface StartFacts {
  /** Whether the dsh base enforces browser-session auth (auto-detected). */
  upstreamSessionAvailable: boolean
}

/**
 * The fail-closed problems that prevent a config from enabling the listener.
 * Returns every problem (not just the first) so the operator sees the full
 * migration at once. Exported for tests.
 */
export function gatewayStartProblems(cfg: Config, facts: StartFacts): string[] {
  const problems: string[] = []
  if (cfg.authRequired === false) {
    problems.push(
      'authRequired=false is no longer supported — authentication is always required. '
      + 'Remove `authRequired` (or set it true); for password-free LAN access set `lanPasswordless: true`.',
    )
  }
  if (cfg.lanPasswordless && !facts.upstreamSessionAvailable) {
    problems.push(
      'lanPasswordless requires a dsh base with browser-session auth (>= 0.1.2-rc.1): the gateway '
      + 'relaxes only its own login, never dsh authorization. Upgrade dsh, or set lanPasswordless: false.',
    )
  }
  const encryptedIngress = cfg.tlsEnabled || cfg.trustedTerminator !== undefined
  if (!encryptedIngress && !cfg.allowInsecurePlaintext) {
    problems.push(
      'Refusing to serve over plaintext HTTP: enable TLS (tlsEnabled: true), declare a trusted '
      + 'TLS-terminating proxy (trustedTerminator), or set allowInsecurePlaintext: true to accept '
      + 'the plaintext exposure (passwords and sessions would travel in clear).',
    )
  }
  return problems
}

/**
 * Resolve the effective `Secure` attribute for the session cookie: an explicit
 * `secureCookies` always wins; unset falls back to automatic — Secure when the
 * gateway terminates TLS itself or a trusted terminator is declared. The
 * override exists for a trusted proxy that authenticates users but speaks plain
 * HTTP to browsers: `encryptedIngress` is a fair proxy for "a proxy is in front"
 * but not for "the browser leg is encrypted", and a Secure cookie on a plain
 * HTTP origin is silently dropped, looping the login.
 *
 * Exported for tests.
 */
export function resolveSecureCookies(
  cfg: Pick<Config, 'secureCookies' | 'tlsEnabled' | 'trustedTerminator'>,
): boolean {
  // Test for a real boolean, not just `!== undefined`: the settings route
  // clears a key by posting null and schemastery passes that through rather
  // than coercing it to undefined, so `null` reaches here on the save path.
  // Only an explicit true/false overrides the automatic rule.
  if (typeof cfg.secureCookies === 'boolean') return cfg.secureCookies
  return cfg.tlsEnabled || cfg.trustedTerminator !== undefined
}

/** Resolve the TLS material for a config, or undefined when TLS is off. */
function resolveTls(cfg: Config): { material: TlsMaterial; renewed: boolean } | undefined {
  if (!cfg.tlsEnabled) return undefined
  if (cfg.tlsMode === 'custom') {
    return { material: loadCustomCert(cfg.tlsCertPath ?? '', cfg.tlsKeyPath ?? ''), renewed: false }
  }
  const hosts = parseSelfSignedHosts(cfg.tlsSelfSignedHosts)
  if (hosts.length === 0) {
    throw new Error('tlsSelfSignedHosts must name at least one host (DNS name or IP)')
  }
  return loadOrRenewSelfSigned({ hosts, days: cfg.tlsCertMaxAgeDays })
}

/**
 * Config fields that require a listener restart when they change, plus whether
 * a shared upstream session relay is available at all. The relay flag belongs
 * in the key: a listener that started before the `connection` service appeared
 * was built without a relay and must restart once the service attaches,
 * otherwise it silently forwards every request anonymously (the upstream 401s)
 * while the status line still claims the relay is active.
 */
function listenerKey(cfg: Config, relayAvailable: boolean): string {
  return JSON.stringify([
    cfg.gatewayPort,
    cfg.dshTargetPort,
    cfg.lanCidrs,
    cfg.lanPasswordless,
    cfg.cookieMaxAgeDays,
    cfg.cookieName,
    cfg.tlsEnabled,
    cfg.tlsMode,
    cfg.tlsCertPath,
    cfg.tlsKeyPath,
    cfg.tlsSelfSignedHosts,
    cfg.tlsCertMaxAgeDays,
    cfg.allowInsecurePlaintext,
    cfg.trustedTerminator,
    cfg.secureCookies,
    relayAvailable,
  ])
}

/**
 * One-line TLS description for status output.
 *
 * Never generates: this is the read path behind `GET /lan-gateway/config` and
 * `lan_gateway status`, and a status query that mints an RSA key and writes a
 * certificate to disk is not a read. The material is created when the listener
 * starts, or by `lan_gateway tls-regenerate`.
 */
function tlsStatusLine(cfg: Config): string {
  if (!cfg.tlsEnabled) return 'off'
  if (cfg.tlsMode === 'custom') {
    return `custom (${cfg.tlsCertPath ?? '?'}, ${cfg.tlsKeyPath ?? '?'})`
  }
  try {
    const status = readSelfSignedStatus()
    if (status === undefined) return 'self-signed (not generated yet — created when the listener starts)'
    const info = describeCert(status.cert)
    return `self-signed [${info.subject}] exp ${info.validTo}`
  } catch (error) {
    return `self-signed (unavailable: ${error instanceof Error ? error.message : String(error)})`
  }
}

/**
 * Same-origin loopback fence for the native `/lan-gateway/config` route. The
 * gateway refuses to relay this prefix, so the only way in is the native
 * loopback listener itself (a genuine local user, or a local process that could
 * already read `~/.dsh`). Host must be loopback (also blocks DNS rebinding),
 * cross-site fetches are refused, an Origin must match the Host the browser
 * used, and a state-changing method must carry that Origin. Exported for tests.
 */
export function isTrustedConfigRequest(req: IncomingMessage): boolean {
  const host = req.headers?.host
  if (typeof host !== 'string' || host === '') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers?.origin
  if (origin !== undefined && !originMatchesHost(origin, host)) return false
  const method = req.method ?? 'GET'
  if (!READ_ONLY_METHODS.has(method) && origin === undefined) return false
  return true
}

/**
 * Turn a submitted config patch into the next user section: only keys the card
 * can edit, only real values, and `null` (or an emptied optional) removes the
 * key rather than storing it.
 *
 * The patch is built from the *submitted* object, never from a schema call's
 * output. Schemastery fills defaults into whatever it validates and passes
 * unknown keys through, so deriving the section from `Config(submitted)` wrote
 * `authRequired: true` (a capability that exists only to be refused) and any
 * stray key into the user's settings on every save — and, because it also
 * materialized `cookieName`, reset an operator's custom cookie name to the
 * schema default.
 *
 * A `null` value is the card's clear: the key is dropped from the patch, which
 * leaves it absent from the section, so it re-inherits the composition layer.
 */
export function buildConfigPatch(submitted: Record<string, unknown>): {
  patch: Record<string, unknown>
  clear: string[]
  unknown: string[]
} {
  const patch: Record<string, unknown> = {}
  const clear: string[] = []
  const unknown: string[] = []
  for (const [key, value] of Object.entries(submitted)) {
    if (!CONFIG_FIELD_KEYS.has(key)) {
      unknown.push(key)
      continue
    }
    if (value === null || value === undefined) {
      clear.push(key)
      continue
    }
    if (typeof value === 'string' && value === '' && OPTIONAL_CONFIG_KEYS.has(key)) {
      clear.push(key)
      continue
    }
    // An empty string on a non-optional text field is a real value the card
    // refuses to submit, but a hand-written POST could send one; let the schema
    // reject it rather than inventing a meaning here.
    patch[key] = value
  }
  return { patch, clear, unknown }
}

export function apply(ctx: Context, config: ConfigRefs): void {
  let state = loadState()
  let gateway: LanGateway | undefined
  let startedWith: string | undefined
  let lastError: string | undefined
  /**
   * The operator's run intent, used only while no settings service is attached.
   * With settings present, `enabled` in the settings section *is* the intent —
   * the card and the tool write the same field, so there is one truth rather
   * than two that disagree.
   */
  let manualOverride: boolean | undefined
  /** Whether the base enforces browser-session auth; set once `connection` is seen. */
  let upstreamSessionAvailable = false
  /**
   * Identifies the current `connection` handler. A provider that detaches and a
   * new one that attaches run their disposers in an order the plugin does not
   * control, and a stale disposer clearing `makeRelay` would strand the live
   * provider — so a disposer only acts if it is still the latest generation.
   */
  let connectionGeneration = 0
  /** Builds a fresh shared-session relay for a dsh port, once the base supports sessions. */
  let makeRelay: ((dshPort: number) => UpstreamSession) | undefined
  /** Whether the settings service is attached, so writes reach the profile entry. */
  let settingsAttached = false
  /**
   * This plugin's own Loader entry id. dsh 0.1.7 addresses a settings write by
   * the *entry id* — the `lan-gateway` namespace this plugin used to register
   * with is gone along with `settingsScope`.
   */
  let settingsEntryId: string | undefined
  /**
   * The settings service, for the one write a merge patch cannot express: a key
   * must be *removed* to re-inherit the composition layer, and only its
   * path-addressed `mutate` can unset one.
   */
  let settingsProvider: SettingsService | undefined
  /**
   * One queue for every lifecycle side effect. Settings changes, tool commands,
   * credential changes, TLS regeneration and plugin disposal all land here, so
   * two of them can never interleave a stop with a start.
   */
  let lifecycle: Promise<void> = Promise.resolve()
  /** Set by the dispose hook; a start that completes after it must undo itself. */
  let disposed = false

  const effective = (): Config => readConfig(config)

  /** Queue one lifecycle action behind every action already running. */
  const enqueue = (reason: string, action: () => Promise<void>): Promise<void> => {
    lifecycle = lifecycle.then(action).catch((error: unknown) => {
      lastError = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`dsh-lan-gateway: ${reason}: ${lastError}`)
    })
    return lifecycle
  }

  const startGateway = async (cfg: Config): Promise<void> => {
    if (gateway !== undefined) return
    const problems = gatewayStartProblems(cfg, { upstreamSessionAvailable })
    if (state.password === undefined) {
      problems.unshift('no password set — run `lan_gateway set-password` before enabling the listener')
    }
    if (problems.length > 0) {
      throw new Error(`dsh-lan-gateway: cannot start — ${problems.join(' ')}`)
    }
    const dshPort = cfg.dshTargetPort ?? ctx.webServer.port
    const resolved = resolveTls(cfg)
    const tls = resolved?.material
    const encryptedIngress = cfg.tlsEnabled || cfg.trustedTerminator !== undefined
    const secureCookies = resolveSecureCookies(cfg)
    const next = new LanGateway({
      gatewayPort: cfg.gatewayPort,
      dshPort,
      lanCidrs: cfg.lanCidrs,
      lanPasswordless: cfg.lanPasswordless,
      cookieMaxAgeDays: cfg.cookieMaxAgeDays,
      cookieName: cfg.cookieName,
      secureCookies,
      ...(tls !== undefined ? { tls } : {}),
      ...(makeRelay !== undefined ? { upstreamSession: makeRelay(dshPort) } : {}),
      onStateChange: (updated) => {
        // The gateway retired a session itself (sign-out). Keep the plugin's
        // copy and the state file in step, or a restart would resurrect a
        // session the user signed out of.
        state = updated
        saveState(state)
      },
    }, state)
    await next.listen()
    // The listen above is asynchronous and the tree can be disposed while it is
    // in flight. Publishing the listener after that would leave a socket owned
    // by nobody — the dispose hook already ran and saw `gateway` undefined.
    if (disposed) {
      await next.close()
      return
    }
    gateway = next
    startedWith = listenerKey(cfg, makeRelay !== undefined)
    ctx.logger.info(
      `dsh-lan-gateway: listening on ${next.boundAddress()}${tls !== undefined ? ' (TLS)' : ''}`
      + ` -> 127.0.0.1:${dshPort}${encryptedIngress ? '' : ' (plaintext, explicit allowInsecurePlaintext)'}`
      + `${makeRelay !== undefined ? ' [shared upstream session relay]' : ' [no upstream session relay: base has no browser-session auth]'}`,
    )
    if (resolved?.renewed === true) {
      ctx.logger.warn(
        'dsh-lan-gateway: the self-signed certificate had expired and was replaced with a fresh one '
        + '— clients that had trusted the old certificate must trust the new one.',
      )
    }
  }

  const stopGateway = async (): Promise<void> => {
    const current = gateway
    gateway = undefined
    startedWith = undefined
    if (current !== undefined) {
      await current.close()
      ctx.logger.info('dsh-lan-gateway: stopped')
    }
  }

  /** The config the listener should be running under, intent included. */
  const desiredConfig = (): Config => {
    const cfg = effective()
    // Without a settings service there is nowhere to record the tool's intent,
    // so it lives in memory as an override on the composition entry. With one
    // attached, the profile entry's `enabled` already carries it and an override
    // would shadow the card — the defect this replaces.
    if (settingsAttached) return cfg
    return manualOverride === undefined ? cfg : { ...cfg, enabled: manualOverride }
  }

  /** Reconcile the listener with the effective config (start/stop/restart). */
  const syncGateway = (reason: string): Promise<void> => {
    return enqueue(reason, async () => {
      lastError = undefined
      if (disposed) return
      const cfg = desiredConfig()
      if (gateway === undefined) {
        if (cfg.enabled) await startGateway(cfg)
      } else if (!cfg.enabled) {
        await stopGateway()
      } else if (startedWith !== listenerKey(cfg, makeRelay !== undefined)) {
        await stopGateway()
        await startGateway(cfg)
      }
    })
  }

  /** Record the run intent where it will survive: the profile entry, or memory. */
  const setRunIntent = async (enabled: boolean): Promise<void> => {
    if (settingsAttached && settingsProvider !== undefined && settingsEntryId !== undefined) {
      // The same field the Settings card writes, in this plugin's own profile
      // entry. A merge patch, so nothing else in the entry is disturbed.
      await settingsProvider.update(settingsEntryId, { enabled })
      // The write updates the config references in place and the loader then
      // emits `loader/volatile-update`, which queues the reconcile; waiting on
      // that here would deadlock behind this same write.
      return
    }
    manualOverride = enabled
  }

  // The tunables live in this plugin's own profile entry, and dsh 0.1.7 reaches
  // it by *entry id*: the `lan-gateway` settings namespace this plugin used to
  // register (and the scope handle it wrote through) no longer exist. The entry
  // id is the Loader's, so it comes from the fiber; without a Loader there is no
  // entry to write and the composition value stands alone.
  ctx.inject(['settings'], (sctx) => {
    const entryId = ctx.fiber.entry?.options.id
    if (entryId === undefined) return
    settingsEntryId = entryId
    settingsProvider = sctx.settings
    settingsAttached = true
    // This plugin ships its own card, so it owns its page policy.
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
    // A committed write updates the volatile references in place (no remount)
    // and emits this, so the listener follows the new config.
    sctx.effect(() => ctx.on('loader/volatile-update', () => { void syncGateway('settings change') }))
    sctx.effect(() => () => {
      // The settings service went away (disposal / provider reload): the
      // composition entry is authoritative again, and the tool's intent falls
      // back to memory. Reconcile so the listener follows it.
      settingsEntryId = undefined
      settingsProvider = undefined
      settingsAttached = false
      void syncGateway('settings detach')
    })
    void syncGateway('settings attach')
  })

  // A session-capable dsh base exposes the `connection` service (0.1.2+). The
  // presence of that service both (a) tells the fail-closed guard that the base
  // itself authenticates and (b) supplies the launch-token URL the shared-session
  // relay exchanges. Optional: on an older base the callback never runs, the
  // gateway forwards without a relay, and lanPasswordless stays refused.
  ctx.inject(['connection'], (ccx) => {
    const generation = ++connectionGeneration
    upstreamSessionAvailable = true
    ctx.logger.info('dsh-lan-gateway: connection service attached; upstream session relay enabled')
    makeRelay = (dshPort) => new UpstreamSessionRelay({
      port: dshPort,
      authenticatedUrl: () => ccx.connection.authenticatedUrl(`http://127.0.0.1:${dshPort}`),
      // The relay never throws, so a failing exchange is otherwise invisible
      // and looks exactly like a base with no browser sessions.
      log: (message) => ctx.logger.info(`dsh-lan-gateway relay: ${message}`),
    })
    ccx.effect(() => () => {
      // The provider went away. Drop the relay factory rather than hold one
      // bound to a disposed context, and let the listenerKey see the change so
      // the running listener does not keep serving through a dead provider.
      if (generation !== connectionGeneration) return
      makeRelay = undefined
      upstreamSessionAvailable = false
      void syncGateway('connection detach')
    })
    // A listener that started before the connection service appeared must
    // restart so it picks up the relay (and the now-correct fail-closed facts).
    void syncGateway('connection attach')
  })

  // The Settings → Plugins card reads and writes through this loopback-only
  // JSON route (ModLens-style: the browser never touches the settings seam
  // directly, so the card has no service dependencies to resolve). The gateway
  // refuses to relay this prefix, so only the native loopback listener can
  // reach it — a genuine local user, or a local process that could already read
  // ~/.dsh.
  const configRouteHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const snapshot = (): Record<string, unknown> => {
      const cfg = effective()
      return {
        config: cfg,
        running: gateway !== undefined,
        port: cfg.gatewayPort,
        tls: tlsStatusLine(cfg),
        upstreamSessionAvailable,
        lastError: lastError ?? null,
      }
    }
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!isTrustedConfigRequest(req)) {
      send(403, { error: 'request refused: this route answers same-origin loopback requests only' })
      return
    }
    if (req.method === 'GET') {
      send(200, snapshot())
      return
    }
    if (req.method !== 'POST') {
      send(405, { error: 'method not allowed' })
      return
    }
    const body = await readBody(req, 64 * 1024, res)
    if (body === undefined) return // response already sent (413/400)
    let submitted: unknown
    try {
      submitted = JSON.parse(body)
    } catch {
      send(400, { error: 'invalid JSON body' })
      return
    }
    if (typeof submitted !== 'object' || submitted === null || Array.isArray(submitted)) {
      send(400, { error: 'body must be a config object' })
      return
    }
    // A settings write is addressed by this plugin's profile entry id; without
    // one (no Loader, or no settings service) the composition value is all there
    // is, and the operator edits the profile patch instead.
    const settings = settingsProvider
    const entryId = settingsEntryId
    if (settings === undefined || entryId === undefined) {
      send(409, { error: 'settings service unavailable — edit the profile patch (cordis.patch.yml) instead' })
      return
    }
    // The patch names only the keys the card can edit; a clear is expressed by
    // omitting the key from the patch, which is what `unset` does to the section
    // as it stands. Unknown keys are reported rather than silently stored.
    const { patch, clear, unknown } = buildConfigPatch(submitted as Record<string, unknown>)
    // Validate the candidate the patch would produce — schema defaults included,
    // exactly as the listener will resolve it — so the save fails closed on an
    // unusable combination instead of persisting it.
    const candidate = validateConfig({ ...effective(), ...patch })
    // A structural problem (legacy authRequired:false, lanPasswordless without
    // a session-capable base) is invalid however it is reached; a start
    // condition (plaintext without TLS/terminator/opt-in) only blocks a save
    // that would actually enable the listener. This lets a disabled, dormant
    // config be tuned without tripping the plaintext guard.
    const structural = candidate.authRequired === false
      || (candidate.lanPasswordless && !upstreamSessionAvailable)
    const problems = gatewayStartProblems(candidate, { upstreamSessionAvailable })
    if (structural || (candidate.enabled && problems.length > 0)) {
      send(409, { error: `config cannot start: ${problems.join(' ')}` })
      return
    }
    try {
      const ops = [
        ...Object.entries(patch).map(([key, value]) => ({ op: 'set' as const, path: [key], value })),
        ...clear.map(key => ({ op: 'unset' as const, path: [key] })),
      ]
      // Path-addressed edits, not a merge patch: a clear has to *remove* the
      // key so it re-inherits the composition layer. Storing null instead would
      // leave a null where the config expects a string, and `!== undefined`
      // tests elsewhere would then read that null as a declared value.
      if (ops.length > 0) await settings.mutate(entryId, ops)
      // The write commits through the section's watcher; reconcile explicitly so
      // the response reports a settled listener rather than a mid-restart one.
      await syncGateway('config route save')
      const next = { ...snapshot() }
      if (unknown.length > 0) {
        // Not an error: an older client may post fields this build dropped. Say
        // so rather than dropping them silently.
        next['ignored'] = unknown
      }
      send(200, next)
    } catch (error) {
      send(409, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: '/lan-gateway/config', handler: configRouteHandler }),
    'dsh-lan-gateway: config route',
  )

  const controller: GatewayController = {
    status(): ToolResult {
      const cfg = desiredConfig()
      const dshPort = cfg.dshTargetPort ?? ctx.webServer.port
      const encrypted = cfg.tlsEnabled || cfg.trustedTerminator !== undefined
      return {
        ok: true,
        message:
          `LAN gateway: ${gateway !== undefined ? `LISTENING on ${gateway.boundAddress()}` : 'stopped'}`
          + `\n- dsh target: 127.0.0.1:${dshPort}`
          + `\n- password: ${state.password !== undefined ? 'set' : 'NOT SET'}`
          + `\n- login required for all sources: true${cfg.lanPasswordless ? ' (LAN/loopback exempt via lanPasswordless)' : ''}`
          + `\n- session epoch: ${state.sessionEpoch}`
          + `\n- signed-out sessions still held: ${Object.keys(state.revokedSessions ?? {}).length} (each drops when its own cookie would have expired)`
          + `\n- upstream session relay: ${upstreamSessionAvailable ? 'active (dsh browser-session auth present)' : 'absent (older dsh base)'}`
          + `\n- ingress: ${cfg.tlsEnabled ? `TLS (${tlsStatusLine(cfg)})` : cfg.trustedTerminator !== undefined ? `trusted proxy (${cfg.trustedTerminator}, ${resolveSecureCookies(cfg) ? 'TLS' : 'plaintext'} browser ingress)` : encrypted ? 'encrypted' : cfg.allowInsecurePlaintext ? 'PLAINTEXT (explicit allowInsecurePlaintext)' : 'plaintext — will not start'}`
          + `\n- session cookie: ${cfg.cookieName}, ${cfg.cookieMaxAgeDays}d, ${resolveSecureCookies(cfg) ? 'Secure' : 'no Secure attribute (plaintext browser ingress)'}`
          + (manualOverride !== undefined && !settingsAttached
            ? `\n- manual override: ${manualOverride ? 'enabled' : 'disabled'}`
            : '')
          + (lastError !== undefined ? `\n- last error: ${lastError}` : ''),
      }
    },
    async enable(): Promise<ToolResult> {
      await setRunIntent(true)
      await syncGateway('tool enable')
      return gateway !== undefined
        ? { ok: true, message: `Gateway enabled: listening on ${gateway.boundAddress()}` }
        : { ok: false, message: `Failed to enable gateway: ${lastError ?? 'unknown error'}` }
    },
    async disable(): Promise<ToolResult> {
      await setRunIntent(false)
      await syncGateway('tool disable')
      return { ok: true, message: 'Gateway disabled.' }
    },
    async setPassword(password: string | undefined): Promise<ToolResult> {
      if (password !== undefined && password.length > 0 && password.length < 8) {
        return { ok: false, message: 'Password must be at least 8 characters.' }
      }
      const setting = password !== undefined && password.length > 0
      const hadPassword = state.password !== undefined
      state = await setPassword(state, setting ? password : undefined)
      saveState(state)
      gateway?.setState(state)
      if (!setting) {
        // Clearing the credential must not leave an open gateway serving
        // sessions the old password authorized: stop the listener. A password
        // is required to run, so a later enable fails closed.
        await setRunIntent(false)
        return enqueue('password cleared', async () => {
          if (gateway !== undefined) await stopGateway()
          lastError = 'Password cleared — the gateway listener was stopped (a password is required to run).'
        }).then(() => ({
          ok: true,
          message: 'Password cleared. Session epoch advanced and the gateway listener was stopped — set a password before enabling it again.',
        }))
      }
      // The first password turns a dormant "enabled but unpassworded" intent
      // into a startable one, so reconcile: the listener was refused a moment
      // ago for a reason that no longer holds. A later password change needs no
      // reconcile (the listener is already running or already refused for some
      // other reason), and reconciling anyway would be harmless but noisy.
      if (!hadPassword) await syncGateway('password set')
      return {
        ok: true,
        message: 'Password set. Session epoch advanced — every previously issued session is now invalid; all sources must sign in again.',
      }
    },
    rotateSecret(): ToolResult {
      const next: GatewayState = {
        cookieSecret: randomBytes(32).toString('base64'),
        sessionEpoch: state.sessionEpoch + 1,
      }
      if (state.password !== undefined) {
        next.password = state.password
      }
      state = next
      saveState(state)
      gateway?.setState(state)
      return { ok: true, message: 'Session secret rotated and epoch advanced. All existing login cookies and live WebSockets are now invalid.' }
    },
    async regenerateTls(): Promise<ToolResult> {
      const cfg = effective()
      if (!cfg.tlsEnabled || cfg.tlsMode !== 'self-signed') {
        return { ok: false, message: 'TLS is off or in custom mode — nothing to regenerate. Enable tlsEnabled with tlsMode=self-signed first.' }
      }
      const hosts = parseSelfSignedHosts(cfg.tlsSelfSignedHosts)
      if (hosts.length === 0) {
        return { ok: false, message: 'tlsSelfSignedHosts must name at least one host (DNS name or IP).' }
      }
      let failure: string | undefined
      // Through the queue like every other lifecycle action: minting the
      // certificate and restarting must not interleave with a settings-driven
      // restart, which is how two listeners ended up racing for one port.
      await enqueue('tls regenerate', async () => {
        try {
          regenerateSelfSigned({ hosts, days: cfg.tlsCertMaxAgeDays })
          if (gateway !== undefined) {
            await stopGateway()
            await startGateway(effective())
          }
          lastError = undefined
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error)
        }
      })
      return failure === undefined
        ? { ok: true, message: 'Self-signed certificate regenerated (new key). Listener restarted with the new certificate.' }
        : { ok: false, message: `Failed to regenerate TLS certificate: ${failure}` }
    },
  }

  // Register the management tool once.
  ctx.tools.register(lanGatewayTool(controller))

  // Own the gateway lifecycle with the cordis tree. The dispose hook only marks
  // the tree gone and queues the stop: everything that could be mid-flight is
  // already holding the queue, and `startGateway` undoes its own listener when
  // it notices the flag.
  ctx.effect(() => {
    void syncGateway('boot')
    return async () => {
      disposed = true
      await enqueue('dispose', stopGateway)
    }
  }, 'dsh-lan-gateway: listener lifecycle')
}
