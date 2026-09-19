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
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { DEFAULT_LAN_CIDR_STRINGS, originMatchesHost } from './auth.ts'
import { LanGateway } from './gateway.ts'
import { readBody } from './login.ts'
import {
  loadState,
  saveState,
  setPassword,
  type GatewayState,
} from './state.ts'
import {
  describeCert,
  loadCustomCert,
  loadOrCreateSelfSigned,
  loadOrRenewSelfSigned,
  parseSelfSignedHosts,
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
   * silently ignored.
   */
  authRequired?: boolean
  /** Session cookie lifetime in days. */
  cookieMaxAgeDays: number
  /** Cookie name. */
  cookieName: string
  /** Whether the gateway listener speaks TLS. */
  tlsEnabled: boolean
  /** Certificate source: auto-generated self-signed, or user-supplied files. */
  tlsMode: 'self-signed' | 'custom'
  /** Custom mode: path to the PEM certificate (or chain). */
  tlsCertPath?: string
  /** Custom mode: path to the PEM private key. */
  tlsKeyPath?: string
  /** Self-signed mode: comma/space separated DNS names and IPs for the SANs. */
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

/**
 * The `lan-gateway` user-settings namespace, mirroring the composition schema.
 * A plain string literal: dsh-settings dropped the `settingsNamespace()` brand
 * helper in 0.1.2-rc.1 and `register` validates the literal itself, so this
 * shape works against both that release line and the older branded one.
 */
const NS = 'lan-gateway'

/** Optional config keys: an empty submitted value clears them back to the composition layer. */
const OPTIONAL_CONFIG_KEYS = new Set(['dshTargetPort', 'tlsCertPath', 'tlsKeyPath', 'trustedTerminator'])

/** Schemastery configuration validated by the Loader. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  gatewayPort: z.natural().min(1).max(65535).default(3081),
  dshTargetPort: z.natural().min(1).max(65535),
  lanCidrs: z.array(String).default([...DEFAULT_LAN_CIDR_STRINGS]),
  lanPasswordless: z.boolean().default(false),
  authRequired: z.boolean().default(true),
  cookieMaxAgeDays: z.natural().min(1).max(365).default(7),
  cookieName: z.string().default('dsh_gw_auth'),
  tlsEnabled: z.boolean().default(false),
  tlsMode: z.union([z.const('self-signed'), z.const('custom')]).default('self-signed'),
  tlsCertPath: z.string(),
  tlsKeyPath: z.string(),
  tlsSelfSignedHosts: z.string().default('localhost'),
  tlsCertMaxAgeDays: z.natural().min(1).max(3650).default(825),
  allowInsecurePlaintext: z.boolean().default(false),
  trustedTerminator: z.string(),
  secureCookies: z.boolean(),
})

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

/** One-line TLS description for status output. */
function tlsStatusLine(cfg: Config): string {
  if (!cfg.tlsEnabled) return 'off'
  if (cfg.tlsMode === 'custom') {
    return `custom (${cfg.tlsCertPath ?? '?'}, ${cfg.tlsKeyPath ?? '?'})`
  }
  try {
    const hosts = parseSelfSignedHosts(cfg.tlsSelfSignedHosts)
    const { material } = loadOrCreateSelfSigned({ hosts, days: cfg.tlsCertMaxAgeDays })
    const info = describeCert(material.cert)
    return `self-signed [${info.subject}] exp ${info.validTo}`
  } catch (error) {
    return `self-signed (unavailable: ${error instanceof Error ? error.message : String(error)})`
  }
}

/** Whether `hostname` is loopback (127/8, localhost, ::1). */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

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

export function apply(ctx: Context, config: Config): void {
  let state = loadState()
  let gateway: LanGateway | undefined
  let startedWith: string | undefined
  let lastError: string | undefined
  let manualOverride: boolean | undefined
  /** Whether the base enforces browser-session auth; set once `connection` is seen. */
  let upstreamSessionAvailable = false
  /** Builds a fresh shared-session relay for a dsh port, once the base supports sessions. */
  let makeRelay: ((dshPort: number) => UpstreamSession) | undefined
  /** The authoritative config: settings section when attached, else composition. */
  let configSource: () => Config = () => config
  /** Serializes listener start/stop/restart so settings changes cannot race. */
  let syncing: Promise<void> = Promise.resolve()

  const effective = (): Config => configSource()

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

  /** Reconcile the listener with the effective config (start/stop/restart). */
  const syncGateway = (reason: string): Promise<void> => {
    syncing = syncing.then(async () => {
      lastError = undefined
      const cfg = effective()
      const shouldRun = manualOverride ?? cfg.enabled
      try {
        if (gateway === undefined) {
          if (shouldRun) await startGateway(cfg)
        } else if (!shouldRun) {
          await stopGateway()
        } else if (startedWith !== listenerKey(cfg, makeRelay !== undefined)) {
          await stopGateway()
          await startGateway(cfg)
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`dsh-lan-gateway: ${reason}: ${lastError}`)
      }
    })
    return syncing
  }

  // The tunables also live in the `lan-gateway` settings section: while the
  // settings service exists, the section (composition base + user overrides)
  // is the authoritative config, and every committed change re-syncs the
  // listener — so the Settings → Plugins page adjusts the gateway live.
  // Registered directly (not via installSettingsSection) so the scope handle
  // is available to the /lan-gateway/config route for writes.
  let settingsScope: SettingsScope<Config> | undefined
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NS, Config, { base: config })
    settingsScope = scope
    configSource = () => scope.get()
    sctx.effect(() => scope.watch(() => { void syncGateway('settings change') }))
    sctx.effect(() => () => {
      // The settings provider went away (disposal / provider reload): fall
      // back to the composition entry so the plugin keeps working as composed.
      configSource = () => config
      settingsScope = undefined
    })
    void syncGateway('settings attach')
  })

  // A session-capable dsh base exposes the `connection` service (0.1.2+). The
  // presence of that service both (a) tells the fail-closed guard that the base
  // itself authenticates and (b) supplies the launch-token URL the shared-session
  // relay exchanges. Optional: on an older base the callback never runs, the
  // gateway forwards without a relay, and lanPasswordless stays refused.
  ctx.inject(['connection'], (ccx) => {
    upstreamSessionAvailable = true
    ctx.logger.info('dsh-lan-gateway: connection service attached; upstream session relay enabled')
    makeRelay = (dshPort) => new UpstreamSessionRelay({
      port: dshPort,
      authenticatedUrl: () => ccx.connection.authenticatedUrl(`http://127.0.0.1:${dshPort}`),
      // The relay never throws, so a failing exchange is otherwise invisible
      // and looks exactly like a base with no browser sessions.
      log: (message) => ctx.logger.info(`dsh-lan-gateway relay: ${message}`),
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
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!isTrustedConfigRequest(req)) {
      send(403, { error: 'request refused: this route answers same-origin loopback requests only' })
      return
    }
    if (req.method === 'GET') {
      const cfg = effective()
      send(200, {
        config: cfg,
        running: gateway !== undefined,
        port: cfg.gatewayPort,
        tls: tlsStatusLine(cfg),
        upstreamSessionAvailable,
        lastError: lastError ?? null,
      })
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
    // The schema callable validates and fills defaults; it throws with a
    // descriptive message on any invalid value.
    let candidate: Config
    try {
      candidate = Config(submitted as Config)
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (settingsScope === undefined) {
      send(409, { error: 'settings service unavailable — edit the profile patch (cordis.patch.yml) instead' })
      return
    }
    // Fail the save early (before persisting) when the candidate is unusable.
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
    // Build the next user section: drop null/undefined and empty optionals
    // (an empty path field re-inherits the composition layer).
    const section: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(candidate)) {
      if (value === null || value === undefined) continue
      if (typeof value === 'string' && value === '' && OPTIONAL_CONFIG_KEYS.has(key)) continue
      section[key] = value
    }
    try {
      await settingsScope.replace(section)
      // Let the listener restart settle before reporting, so `running` is
      // accurate instead of a mid-restart snapshot.
      await syncGateway('config route save')
      const cfg = effective()
      send(200, {
        config: cfg,
        running: gateway !== undefined,
        port: cfg.gatewayPort,
        tls: tlsStatusLine(cfg),
        upstreamSessionAvailable,
        lastError: lastError ?? null,
      })
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
      const cfg = effective()
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
          + (manualOverride !== undefined
            ? `\n- manual override: ${manualOverride ? 'enabled' : 'disabled'}`
            : '')
          + (lastError !== undefined ? `\n- last error: ${lastError}` : ''),
      }
    },
    async enable(): Promise<ToolResult> {
      manualOverride = true
      await syncGateway('tool enable')
      return gateway !== undefined
        ? { ok: true, message: `Gateway enabled: listening on ${gateway.boundAddress()}` }
        : { ok: false, message: `Failed to enable gateway: ${lastError ?? 'unknown error'}` }
    },
    async disable(): Promise<ToolResult> {
      manualOverride = false
      await syncGateway('tool disable')
      return { ok: true, message: 'Gateway disabled.' }
    },
    async setPassword(password: string | undefined): Promise<ToolResult> {
      if (password !== undefined && password.length > 0 && password.length < 8) {
        return { ok: false, message: 'Password must be at least 8 characters.' }
      }
      const setting = password !== undefined && password.length > 0
      const previous = state
      state = setPassword(state, setting ? password : undefined)
      saveState(state)
      gateway?.setState(state)
      if (!setting) {
        // Clearing the credential must not leave an open gateway serving
        // sessions the old password authorized: stop the listener. A password
        // is required to run, so a later enable fails closed.
        manualOverride = false
        if (gateway !== undefined) {
          await stopGateway()
          lastError = 'Password cleared — the gateway listener was stopped (a password is required to run).'
          void syncGateway('password cleared')
        }
        return {
          ok: true,
          message: 'Password cleared. Session epoch advanced and the gateway listener was stopped — set a password before enabling it again.',
        }
      }
      void (previous === undefined ? syncGateway('password set') : Promise.resolve())
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
      try {
        regenerateSelfSigned({ hosts, days: cfg.tlsCertMaxAgeDays })
        if (gateway !== undefined) {
          await stopGateway()
          await startGateway(effective())
          lastError = undefined
        }
        return { ok: true, message: 'Self-signed certificate regenerated (new key). Listener restarted with the new certificate.' }
      } catch (error) {
        return {
          ok: false,
          message: `Failed to regenerate TLS certificate: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  }

  // Register the management tool once.
  ctx.tools.register(lanGatewayTool(controller))

  // Own the gateway lifecycle with the cordis tree.
  ctx.effect(() => {
    void syncGateway('boot')
    return stopGateway
  }, 'dsh-lan-gateway: listener lifecycle')
}
