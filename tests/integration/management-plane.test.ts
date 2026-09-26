/**
 * Management-plane round-trip tests: a fake cordis context driving the real
 * `apply()`, the real `LanGateway`, and a stand-in for the 0.1.7 settings
 * service, so the two ways an operator changes the gateway — the `lan_gateway`
 * tool and the Settings card's config route — are exercised against one shared
 * state rather than against a summary of it.
 *
 * Since dsh 0.1.7 a settings write is addressed by the plugin's own **profile
 * entry id** (there is no `lan-gateway` settings namespace any more), and the
 * Loader reflects a committed write by updating the volatile config references
 * in place. `MemorySettings` below reproduces both, so a route save really does
 * change what the listener resolves.
 *
 * `process.env.HOME` is pointed at a temp dir before anything runs: `state.ts`
 * and `tls.ts` both resolve `~/.dsh/lan-gateway` through `os.homedir()`, which
 * reads `HOME` at call time, so the plugin's real files are never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  apply,
  configRefs,
  validateConfig,
  type Config as GatewayConfig,
  type ConfigRefs,
} from '../../src/index.ts'
import { DEFAULT_LAN_CIDR_STRINGS } from '../../src/auth.ts'

/** The dsh port the fake web server claims; nothing listens on it. */
const DSH_PORT = 13080

/** The profile entry id the fake Loader mounts this plugin under. */
const ENTRY_ID = 'dsh-lan-gateway'

/** One path-addressed settings edit, as the 0.1.7 service takes them. */
type PathOp = { op: 'set'; path: readonly string[]; value: unknown } | { op: 'unset'; path: readonly string[] }

/**
 * An in-memory stand-in for the 0.1.7 settings service: one document keyed by
 * profile entry id, no disk. It exposes the surface `SettingsForms` does — and
 * deliberately not `register`, which 0.1.7 removed; a plugin that still calls it
 * fails here the same way it fails in the harness.
 */
class MemorySettings {
  doc: Record<string, Record<string, unknown>> = {}
  readonly writable = true

  constructor(private readonly onWrite: (entryId: string) => void) {}

  /** Page policy for a plugin that ships its own card; nothing to record. */
  configure(): () => void {
    return () => {}
  }

  async update(entryId: string, patch: Record<string, unknown>): Promise<void> {
    this.doc[entryId] = { ...this.doc[entryId], ...patch }
    this.onWrite(entryId)
  }

  async mutate(entryId: string, ops: readonly PathOp[]): Promise<void> {
    const section = { ...this.doc[entryId] }
    for (const op of ops) {
      const key = op.path[0]
      if (key === undefined) continue
      if (op.op === 'set') section[key] = op.value
      else delete section[key]
    }
    this.doc[entryId] = section
    this.onWrite(entryId)
  }

  /** The stored user section for an entry, as a write would have left it. */
  storedSection(entryId: string): Record<string, unknown> {
    return this.doc[entryId] ?? {}
  }
}

/**
 * A real `apply()` needs the composition config the Loader would have
 * validated, so every default is filled in and then overridden per test.
 */
function baseConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return validateConfig({
    enabled: false,
    // Never bound by the tests that leave the listener stopped; the ones that
    // start it pass an explicit free port. Port 0 is not an option: the schema
    // is `z.natural().min(1)`, so "any free port" is not expressible.
    gatewayPort: 13081,
    dshTargetPort: DSH_PORT,
    lanCidrs: [...DEFAULT_LAN_CIDR_STRINGS],
    lanPasswordless: false,
    authRequired: true,
    cookieMaxAgeDays: 7,
    cookieName: 'dsh_gw_auth',
    tlsEnabled: false,
    tlsMode: 'self-signed',
    tlsSelfSignedHosts: 'localhost',
    tlsCertMaxAgeDays: 825,
    allowInsecurePlaintext: true,
    ...overrides,
  })
}

/** The slice of `Context` `apply()` actually touches, with the seams captured. */
interface Harness {
  provider: MemorySettings
  routes: Map<string, RouteHandler>
  logs: string[]
  tool: () => ToolDefinition
  /** Call the `lan_gateway` tool the way the registry would. */
  run: (args: Record<string, unknown>) => Promise<{ ok: boolean; message: string }>
  /** POST a config patch through the plugin's own route. */
  post: (body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>
  /** GET the route snapshot. */
  get: () => Promise<{ status: number; body: Record<string, unknown> }>
  dispose: () => Promise<void>
}

type RouteHandler = (req: unknown, res: unknown) => void | Promise<void>

/**
 * Build the fake context and run the real `apply()` against it. `settings` and
 * `connection` decide which optional services the plugin sees at attach time.
 */
function harness(
  config: GatewayConfig,
  options: { settings?: boolean; connection?: boolean } = {},
): Harness {
  const routes = new Map<string, RouteHandler>()
  const logs: string[] = []
  const teardown: Array<() => Promise<void> | void> = []
  let registered: ToolDefinition | undefined
  /**
   * The live config references `apply` is handed, exactly as the Loader builds
   * them: one reference per volatile field.
   */
  const refs: ConfigRefs = configRefs({ ...config })
  /** Listeners for `loader/volatile-update`, which the plugin re-syncs on. */
  const volatileListeners = new Set<() => void>()

  /**
   * Reflect a committed entry write into the live references, the way the
   * Loader does: re-resolve the entry, copy each value into its reference in
   * place, then announce it. Without this the plugin would keep serving the
   * pre-write config and every round-trip assertion below would be vacuous.
   */
  const provider = new MemorySettings((entryId) => {
    const resolved = configRefs({ ...config, ...provider.storedSection(entryId) })
    for (const [key, ref] of Object.entries(refs)) {
      const source = (resolved as Record<string, { get(): unknown } | undefined>)[key]
      if (ref !== undefined && source !== undefined) updateVolatile(ref, source)
    }
    for (const listener of volatileListeners) listener()
  })

  const effect = (body: () => unknown): (() => void) => {
    const result = body()
    const record = (disposer: unknown): void => {
      if (typeof disposer === 'function') teardown.push(disposer as () => void)
    }
    if (result instanceof Promise) void result.then(record)
    else record(result)
    return () => {}
  }

  const ctx = {
    logger: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
    },
    webServer: {
      port: DSH_PORT,
      register(route: { path: string; handler: RouteHandler }) {
        routes.set(route.path, route.handler)
        const off = (): void => { routes.delete(route.path) }
        teardown.push(off)
        return off
      },
    },
    tools: {
      register(tool: ToolDefinition) {
        registered = tool
        return () => {}
      },
    },
    effect,
    // The plugin reads its own profile entry id from the fiber: that id, not a
    // `lan-gateway` namespace, is what a settings write is addressed by.
    fiber: { entry: { options: { id: ENTRY_ID } } },
    on(event: string, listener: () => void) {
      if (event !== 'loader/volatile-update') return () => {}
      volatileListeners.add(listener)
      return () => { volatileListeners.delete(listener) }
    },
    inject(names: string[], callback: (child: unknown) => void) {
      const child: Record<string, unknown> = { logger: ctx.logger, effect }
      if (options.settings === true) child['settings'] = provider
      if (options.connection === true) {
        child['connection'] = {
          authenticatedUrl: (base: string) => `${base}/?token=launch-token`,
        }
      }
      if (names.every(name => child[name] !== undefined)) callback(child)
      return () => {}
    },
  }

  apply(ctx as never, refs)

  const handler = (): RouteHandler => {
    const found = routes.get('/lan-gateway/config')
    if (found === undefined) throw new Error('the config route was never registered')
    return found
  }

  const callRoute = async (method: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const req = new EventEmitter() as EventEmitter & { method: string; headers: Record<string, string>; url: string }
    req.method = method
    req.url = '/lan-gateway/config'
    // A loopback Host with a matching Origin: the route's own fence, satisfied.
    req.headers = { host: `127.0.0.1:${DSH_PORT}` }
    if (body !== undefined) req.headers['origin'] = `http://127.0.0.1:${DSH_PORT}`

    const done = new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
      const res = {
        statusCode: 0,
        writeHead(status: number) { this.statusCode = status; return this },
        end(chunk?: string) {
          resolve({
            status: this.statusCode,
            body: typeof chunk === 'string' && chunk !== '' ? JSON.parse(chunk) as Record<string, unknown> : {},
          })
        },
      }
      void Promise.resolve(handler()(req, res)).catch(() => {})
    })

    queueMicrotask(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
      req.emit('end')
    })
    return done
  }

  const controllerExec = { signal: new AbortController().signal } as unknown as ToolRunContext

  return {
    provider,
    routes,
    logs,
    tool: () => {
      if (registered === undefined) throw new Error('the tool was never registered')
      return registered
    },
    async run(args) {
      const result = await registered!.execute(args, controllerExec)
      return result as { ok: boolean; message: string }
    },
    post: body => callRoute('POST', body),
    get: () => callRoute('GET'),
    async dispose() {
      for (const off of teardown.reverse()) await off()
    },
  }
}

/** A free loopback port, released immediately for the gateway to claim. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => { resolve(port) })
    })
  })
}

let home = ''
let originalHome: string | undefined
let live: Harness[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lan-gateway-mgmt-'))
  originalHome = process.env['HOME']
  process.env['HOME'] = home
  live = []
})

afterEach(async () => {
  for (const h of live) await h.dispose()
  if (originalHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = originalHome
  rmSync(home, { recursive: true, force: true })
})

/** Build a harness and register it for teardown. */
function start(config: GatewayConfig, options: Parameters<typeof harness>[1] = {}): Harness {
  const h = harness(config, options)
  live.push(h)
  return h
}

const PASSWORD = 'correct-horse-battery'

describe('the Settings card save path', () => {
  it('stores only the submitted key, leaving unedited and unknown ones alone', async () => {
    // The composition layer names a cookie the card cannot even render. Under
    // the old wholesale-replace save, posting any unrelated field reset it to
    // the schema default, and the operator's existing login cookies stopped
    // being recognized.
    const h = start(baseConfig({ cookieName: 'custom_cookie' }), { settings: true })

    const response = await h.post({ gatewayPort: 3099, evil: 'payload' })

    expect(response.status).toBe(200)
    expect(h.provider.storedSection(ENTRY_ID)).toEqual({ gatewayPort: 3099 })
    // The unknown key was reported rather than silently stored.
    expect(response.body['ignored']).toEqual(['evil'])
    // No schema default was written into the user section, and the one real
    // edit did land.
    expect(await currentConfig(h)).toMatchObject({ cookieName: 'custom_cookie', gatewayPort: 3099 })
    expect(h.provider.storedSection(ENTRY_ID)['authRequired']).toBeUndefined()
  })

  it('never writes the refused legacy capability into the user section', async () => {
    const h = start(baseConfig(), { settings: true })
    await h.post({ gatewayPort: 3099 })
    expect(h.provider.storedSection(ENTRY_ID)['authRequired']).toBeUndefined()
  })

  it('clears a key on null so it re-inherits the composition layer', async () => {
    const h = start(baseConfig({ trustedTerminator: 'nginx' }), { settings: true })
    await h.post({ trustedTerminator: null })

    // Removed from the section, not stored as null — a stored null would read
    // as "a terminator is declared" to every `!== undefined` test.
    expect(h.provider.storedSection(ENTRY_ID)).toEqual({})
    expect(await currentConfig(h)).toMatchObject({ trustedTerminator: 'nginx' })
  })

  it('clears an optional field emptied in the form', async () => {
    const h = start(baseConfig({ tlsCertPath: '/etc/ssl/cert.pem' }), { settings: true })
    await h.post({ tlsCertPath: '' })
    expect(h.provider.storedSection(ENTRY_ID)).toEqual({})
    expect(await currentConfig(h)).toMatchObject({ tlsCertPath: '/etc/ssl/cert.pem' })
  })

  it('refuses a save that would enable an unstartable config, and stores nothing', async () => {
    const h = start(baseConfig({ allowInsecurePlaintext: false }), { settings: true })
    const response = await h.post({ enabled: true })
    expect(response.status).toBe(409)
    expect(String(response.body['error'])).toContain('plaintext')
    expect(h.provider.storedSection(ENTRY_ID)).toEqual({})
  })

  it('allows tuning a dormant config that would not be allowed to start', async () => {
    // The plaintext guard gates *starting*, not editing: an operator has to be
    // able to prepare a disabled config before switching it on.
    const h = start(baseConfig({ allowInsecurePlaintext: false }), { settings: true })
    const response = await h.post({ gatewayPort: 3099, enabled: false })
    expect(response.status).toBe(200)
    expect(h.provider.storedSection(ENTRY_ID)).toEqual({ enabled: false, gatewayPort: 3099 })
  })

  it('refuses a cross-site save from a non-loopback Host', async () => {
    const h = start(baseConfig(), { settings: true })
    const handler = h.routes.get('/lan-gateway/config')!
    const outcome = await new Promise<number>((resolve) => {
      const req = new EventEmitter() as EventEmitter & { method: string; headers: Record<string, string> }
      req.method = 'GET'
      req.headers = { host: 'gw.example:3081' }
      const res = {
        statusCode: 0,
        writeHead(status: number) { this.statusCode = status; return this },
        end() { resolve(this.statusCode) },
      }
      void Promise.resolve(handler(req, res)).catch(() => {})
      queueMicrotask(() => req.emit('end'))
    })
    expect(outcome).toBe(403)
  })

  it('reports 409 when no settings service is attached', async () => {
    const h = start(baseConfig())
    const response = await h.post({ gatewayPort: 3099 })
    expect(response.status).toBe(409)
  })
})

describe('the tool and the card share one run intent', () => {
  it('starts from the tool, stops from the card', async () => {
    const port = await freePort()
    const h = start(baseConfig({ gatewayPort: port }), { settings: true })
    await h.run({ command: 'set-password', password: PASSWORD })

    expect((await h.run({ command: 'enable' })).ok).toBe(true)
    expect(await running(h)).toBe(true)
    // The card writes the same field the tool wrote, so it can undo it. Under
    // the old design the tool held a private override the card could not reach.
    await h.post({ enabled: false })
    expect(await running(h)).toBe(false)
  })

  it('starts from the card, stops from the tool', async () => {
    const port = await freePort()
    const h = start(baseConfig({ gatewayPort: port }), { settings: true })
    await h.run({ command: 'set-password', password: PASSWORD })

    await h.post({ enabled: true })
    expect(await running(h)).toBe(true)
    expect((await h.run({ command: 'disable' })).ok).toBe(true)
    expect(await running(h)).toBe(false)
  })

  it('records the tool intent in the section, so a restart honours it', async () => {
    const port = await freePort()
    const h = start(baseConfig({ gatewayPort: port }), { settings: true })
    await h.run({ command: 'set-password', password: PASSWORD })
    await h.run({ command: 'enable' })

    expect(h.provider.storedSection(ENTRY_ID)).toMatchObject({ enabled: true })
  })

  it('leaves the run intent in memory when no settings service exists', async () => {
    const port = await freePort()
    const h = start(baseConfig({ gatewayPort: port }))
    await h.run({ command: 'set-password', password: PASSWORD })
    expect((await h.run({ command: 'enable' })).ok).toBe(true)
    expect(await running(h)).toBe(true)
    expect((await h.run({ command: 'status' })).message).toContain('manual override: enabled')
  })
})

describe('first password reconciles a pending enable intent', () => {
  it('starts the gateway once the credential that was blocking it arrives', async () => {
    const port = await freePort()
    const h = start(baseConfig({ gatewayPort: port, enabled: true }), { settings: true })

    // The intent is recorded, but the listener is refused: no password yet.
    const refused = await h.run({ command: 'enable' })
    expect(refused.ok).toBe(false)
    expect(await running(h)).toBe(false)

    // Setting the first password clears the only standing reason to refuse.
    expect((await h.run({ command: 'set-password', password: PASSWORD })).ok).toBe(true)
    expect(await running(h)).toBe(true)
  })

  it('does not start when the intent was never expressed', async () => {
    const port = await freePort()
    const h = start(baseConfig({ gatewayPort: port, enabled: false }), { settings: true })
    await h.run({ command: 'set-password', password: PASSWORD })
    expect(await running(h)).toBe(false)
  })

  it('stops and records why when the password is cleared', async () => {
    const port = await freePort()
    const h = start(baseConfig({ gatewayPort: port }), { settings: true })
    await h.run({ command: 'set-password', password: PASSWORD })
    await h.run({ command: 'enable' })
    expect(await running(h)).toBe(true)

    const cleared = await h.run({ command: 'set-password', password: '' })
    expect(cleared.ok).toBe(true)
    expect(await running(h)).toBe(false)
    // A cleared credential is a standing refusal, so re-enabling must not
    // silently start a gateway nobody can sign in to.
    expect((await h.run({ command: 'enable' })).ok).toBe(false)
  })
})

/** Whether the plugin believes its listener is up, read through the tool. */
async function running(h: Harness): Promise<boolean> {
  const status = await h.run({ command: 'status' })
  const listening = status.message.includes('LISTENING')
  const stopped = status.message.includes('stopped')
  if (listening === stopped) throw new Error(`ambiguous status line: ${status.message}`)
  return listening
}

/** The config the plugin currently resolves, read through the route snapshot. */
async function currentConfig(h: Harness): Promise<Record<string, unknown>> {
  const snapshot = await h.get()
  expect(snapshot.status).toBe(200)
  return snapshot.body['config'] as Record<string, unknown>
}
