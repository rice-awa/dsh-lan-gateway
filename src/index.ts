/**
 * @dsh-external/dsh-lan-gateway — the LAN/internet gateway plugin for the
 * DeepSeek Harness web GUI.
 *
 * dsh's web CLI hard-refuses `--host 0.0.0.0` (exposing remote code execution
 * to the network), so this plugin leaves dsh bound to 127.0.0.1 and starts its
 * own reverse-proxy gateway on 0.0.0.0 that forwards to the loopback dsh port,
 * rewriting Host/Origin so the `/api` trust fence passes. LAN and loopback
 * sources are proxied password-free; anything else must complete the login
 * page and present the HMAC cookie.
 *
 * Disabled by default in the bundle patch (safe): the listener opens only
 * after `lan_gateway enable`.
 *
 * @module @dsh-external/dsh-lan-gateway
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_LAN_CIDR_STRINGS } from './auth.ts'
import { LanGateway } from './gateway.ts'
import {
  loadState,
  saveState,
  setPassword,
  type GatewayState,
} from './state.ts'
import { lanGatewayTool } from './tool.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-lan-gateway'

/** Requires the web server service (binds before this row's apply runs) and the tool registry. */
export const inject = ['webServer', 'tools']

/** Minimal surface of the dsh web server service this plugin reads. */
export interface WebServerSurface {
  port: number
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
}

/** Schemastery configuration validated by the Loader. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  gatewayPort: z.natural().min(1).max(65535).default(3081),
  dshTargetPort: z.natural().min(1).max(65535),
  lanCidrs: z.array(String).default([...DEFAULT_LAN_CIDR_STRINGS]),
  authRequired: z.boolean().default(true),
  cookieMaxAgeDays: z.natural().min(1).max(365).default(7),
  cookieName: z.string().default('dsh_gw_auth'),
})

export function apply(ctx: Context, config: Config): void {
  let state = loadState()
  let gateway: LanGateway | undefined

  const startGateway = async (): Promise<void> => {
    if (gateway !== undefined) return
    if (config.authRequired && state.password === undefined) {
      // A passwordless gateway exposed to non-LAN sources would be an open
      // remote-code-execution door. Refuse to listen until a password is set.
      throw new Error(
        'dsh-lan-gateway: no password set — run `lan_gateway set-password` (or set '
        + 'authRequired=false in the plugin config) before enabling.',
      )
    }
    const dshPort = config.dshTargetPort ?? ctx.webServer.port
    const next = new LanGateway({
      gatewayPort: config.gatewayPort,
      dshPort,
      lanCidrs: config.lanCidrs,
      authRequired: config.authRequired,
      cookieMaxAgeDays: config.cookieMaxAgeDays,
      cookieName: config.cookieName,
    }, state)
    await next.listen()
    gateway = next
    ctx.logger.info(
      `dsh-lan-gateway: listening on 0.0.0.0:${config.gatewayPort} -> 127.0.0.1:${dshPort}`,
    )
  }

  const stopGateway = async (): Promise<void> => {
    const current = gateway
    gateway = undefined
    if (current !== undefined) {
      await current.close()
      ctx.logger.info('dsh-lan-gateway: stopped')
    }
  }

  const controller: GatewayController = {
    status(): ToolResult {
      const dshPort = config.dshTargetPort ?? ctx.webServer.port
      return {
        ok: true,
        message:
          `LAN gateway: ${gateway !== undefined ? `LISTENING on 0.0.0.0:${config.gatewayPort}` : 'stopped'}`
          + `\n- dsh target: 127.0.0.1:${dshPort}`
          + `\n- password: ${state.password !== undefined ? 'set' : 'NOT SET'}`
          + `\n- auth required for non-LAN: ${config.authRequired}`
          + `\n- trusted LAN CIDRs: ${config.lanCidrs.join(', ') || '(none)'}`
          + `\n- session cookie: ${config.cookieName}, ${config.cookieMaxAgeDays}d`,
      }
    },
    async enable(): Promise<ToolResult> {
      try {
        await startGateway()
        return { ok: true, message: `Gateway enabled: listening on 0.0.0.0:${config.gatewayPort}` }
      } catch (err) {
        return {
          ok: false,
          message: `Failed to enable gateway: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
    async disable(): Promise<ToolResult> {
      await stopGateway()
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
  }

  // Register the management tool once.
  ctx.tools.register(lanGatewayTool(controller))

  // Own the gateway lifecycle with the cordis tree.
  ctx.effect(async () => {
    if (config.enabled) {
      try {
        await startGateway()
      } catch (err) {
        // A configured-but-unstartable gateway fails loud at boot.
        ctx.logger.warn(`dsh-lan-gateway: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return stopGateway
  }, 'dsh-lan-gateway: listener lifecycle')
}
