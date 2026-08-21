/**
 * @riceawa/dsh-lan-gateway — the LAN/internet gateway plugin for the
 * DeepSeek Harness web GUI.
 *
 * dsh's web CLI hard-refuses `--host 0.0.0.0` (exposing remote code execution
 * to the network), so this plugin leaves dsh bound to 127.0.0.1 and starts its
 * own reverse-proxy gateway on 0.0.0.0 that forwards to the loopback dsh port,
 * rewriting Host/Origin so the `/api` trust fence passes. LAN and loopback
 * sources are proxied password-free; anything else must complete the login
 * page and present the HMAC cookie.
 *
 * The gateway listener can speak TLS: either a persisted auto-generated
 * self-signed certificate (`tlsMode: 'self-signed'`, hosts from
 * `tlsSelfSignedHosts`) or a user-supplied PEM pair (`tlsMode: 'custom'`,
 * `tlsCertPath` + `tlsKeyPath`).
 *
 * Every tunable is also exposed as the `lan-gateway` user-settings namespace
 * (`ctx.settings`), so the official DSH Settings → Plugins page can adjust
 * port, CIDRs, auth, and TLS live; the running listener restarts on change.
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
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { DEFAULT_LAN_CIDR_STRINGS } from './auth.ts'
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
  parseSelfSignedHosts,
  regenerateSelfSigned,
  type TlsMaterial,
} from './tls.ts'
import { lanGatewayTool } from './tool.ts'

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

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: WebServerSurface
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
  setPassword(password: string | undefined): ToolResult
  rotateSecret(): ToolResult
  regenerateTls(): Promise<ToolResult>
}

/** Deployment configuration (composition-level; secrets live in state.json). */
export interface Config {
  /** Whether the gateway listener is started at boot. Default false (safe). */
  enabled: boolean
  /** Port to bind on 0.0.0.0. */
  gatewayPort: number
  /** Explicit dsh target port; defaults to the live `ctx.webServer.port`. */
  dshTargetPort?: number
  /** LAN CIDRs treated as password-free. */
  lanCidrs: string[]
  /** Whether non-LAN sources must authenticate. */
  authRequired: boolean
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
  /** Self-signed certificate validity in days (default 825 ≈ 27 months). */
  tlsCertMaxAgeDays: number
}

/** The `lan-gateway` user-settings namespace, mirroring the composition schema. */
const NS = settingsNamespace('lan-gateway')

/** Optional config keys: an empty submitted value clears them back to the composition layer. */
const OPTIONAL_CONFIG_KEYS = new Set(['dshTargetPort', 'tlsCertPath', 'tlsKeyPath'])

/** Schemastery configuration validated by the Loader. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  gatewayPort: z.natural().min(1).max(65535).default(3081),
  dshTargetPort: z.natural().min(1).max(65535),
  lanCidrs: z.array(String).default([...DEFAULT_LAN_CIDR_STRINGS]),
  authRequired: z.boolean().default(true),
  cookieMaxAgeDays: z.natural().min(1).max(365).default(7),
  cookieName: z.string().default('dsh_gw_auth'),
  tlsEnabled: z.boolean().default(false),
  tlsMode: z.union([z.const('self-signed'), z.const('custom')]).default('self-signed'),
  tlsCertPath: z.string(),
  tlsKeyPath: z.string(),
  tlsSelfSignedHosts: z.string().default('localhost'),
  tlsCertMaxAgeDays: z.natural().min(1).max(3650).default(825),
})

/** Resolve the TLS material for a config, or undefined when TLS is off. */
function resolveTls(cfg: Config): TlsMaterial | undefined {
  if (!cfg.tlsEnabled) return undefined
  if (cfg.tlsMode === 'custom') {
    return loadCustomCert(cfg.tlsCertPath ?? '', cfg.tlsKeyPath ?? '')
  }
  const hosts = parseSelfSignedHosts(cfg.tlsSelfSignedHosts)
  if (hosts.length === 0) {
    throw new Error('tlsSelfSignedHosts must name at least one host (DNS name or IP)')
  }
  const { material } = loadOrCreateSelfSigned({ hosts, days: cfg.tlsCertMaxAgeDays })
  return material
}

/** Config fields that require a listener restart when they change. */
function listenerKey(cfg: Config): string {
  return JSON.stringify([
    cfg.gatewayPort,
    cfg.dshTargetPort,
    cfg.lanCidrs,
    cfg.authRequired,
    cfg.cookieMaxAgeDays,
    cfg.cookieName,
    cfg.tlsEnabled,
    cfg.tlsMode,
    cfg.tlsCertPath,
    cfg.tlsKeyPath,
    cfg.tlsSelfSignedHosts,
    cfg.tlsCertMaxAgeDays,
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

/**
 * Same-origin loopback fence for the config route (mirrors the fence the dsh
 * host uses for its own /api, and what dsh-lan-gateway's sibling plugins do):
 * the Host must be loopback (the gateway rewrites it), cross-site fetches are
 * refused, and any Origin must match the Host the browser actually used.
 */
function isTrustedRequest(req: IncomingMessage): boolean {
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
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

export function apply(ctx: Context, config: Config): void {
  let state = loadState()
  let gateway: LanGateway | undefined
  let startedWith: string | undefined
  let lastError: string | undefined
  let manualOverride: boolean | undefined
  /** The authoritative config: settings section when attached, else composition. */
  let configSource: () => Config = () => config
  /** Serializes listener start/stop/restart so settings changes cannot race. */
  let syncing: Promise<void> = Promise.resolve()

  const effective = (): Config => configSource()

  const startGateway = async (cfg: Config): Promise<void> => {
    if (gateway !== undefined) return
    if (cfg.authRequired && state.password === undefined) {
      // A passwordless gateway exposed to non-LAN sources would be an open
      // remote-code-execution door. Refuse to listen until a password is set.
      throw new Error(
        'dsh-lan-gateway: no password set — run `lan_gateway set-password` (or set '
        + 'authRequired=false in the plugin config) before enabling.',
      )
    }
    const dshPort = cfg.dshTargetPort ?? ctx.webServer.port
    const tls = resolveTls(cfg)
    const next = new LanGateway({
      gatewayPort: cfg.gatewayPort,
      dshPort,
      lanCidrs: cfg.lanCidrs,
      authRequired: cfg.authRequired,
      cookieMaxAgeDays: cfg.cookieMaxAgeDays,
      cookieName: cfg.cookieName,
      ...(tls !== undefined ? { tls } : {}),
    }, state)
    await next.listen()
    gateway = next
    startedWith = listenerKey(cfg)
    ctx.logger.info(
      `dsh-lan-gateway: listening on 0.0.0.0:${cfg.gatewayPort}${tls !== undefined ? ' (TLS)' : ''} -> 127.0.0.1:${dshPort}`,
    )
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
        } else if (startedWith !== listenerKey(cfg)) {
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

  // The Settings → Plugins card reads and writes through this loopback-only
  // JSON route (ModLens-style: the browser never touches the settings seam
  // directly, so the card has no service dependencies to resolve).
  const configRouteHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!isTrustedRequest(req)) {
      send(403, { error: 'request refused: this route answers loopback-origin requests only' })
      return
    }
    if (req.method === 'GET') {
      const cfg = effective()
      send(200, {
        config: cfg,
        running: gateway !== undefined,
        port: cfg.gatewayPort,
        tls: tlsStatusLine(cfg),
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
      return {
        ok: true,
        message:
          `LAN gateway: ${gateway !== undefined ? `LISTENING on 0.0.0.0:${cfg.gatewayPort}` : 'stopped'}`
          + `\n- dsh target: 127.0.0.1:${dshPort}`
          + `\n- password: ${state.password !== undefined ? 'set' : 'NOT SET'}`
          + `\n- auth required for non-LAN: ${cfg.authRequired}`
          + `\n- trusted LAN CIDRs: ${cfg.lanCidrs.join(', ') || '(none)'}`
          + `\n- session cookie: ${cfg.cookieName}, ${cfg.cookieMaxAgeDays}d`
          + `\n- TLS: ${tlsStatusLine(cfg)}`
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
        ? { ok: true, message: `Gateway enabled: listening on 0.0.0.0:${effective().gatewayPort}` }
        : { ok: false, message: `Failed to enable gateway: ${lastError ?? 'unknown error'}` }
    },
    async disable(): Promise<ToolResult> {
      manualOverride = false
      await syncGateway('tool disable')
      return { ok: true, message: 'Gateway disabled.' }
    },
    setPassword(password: string | undefined): ToolResult {
      if (password !== undefined && password.length > 0 && password.length < 8) {
        return { ok: false, message: 'Password must be at least 8 characters.' }
      }
      const setting = password !== undefined && password.length > 0
      state = setPassword(state, setting ? password : undefined)
      saveState(state)
      gateway?.setState(state)
      return {
        ok: true,
        message: setting
          ? 'Password set. Non-LAN access now requires it.'
          : 'Password cleared. Non-LAN access is now password-free (only safe if authRequired is false or no non-LAN sources exist).',
      }
    },
    rotateSecret(): ToolResult {
      const next: GatewayState = { cookieSecret: randomBytes(32).toString('base64') }
      if (state.password !== undefined) {
        next.password = state.password
      }
      state = next
      saveState(state)
      gateway?.setState(state)
      return { ok: true, message: 'Session secret rotated. All existing login cookies are now invalid.' }
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
  ctx.effect(async () => {
    await syncGateway('boot')
    return stopGateway
  }, 'dsh-lan-gateway: listener lifecycle')
}
