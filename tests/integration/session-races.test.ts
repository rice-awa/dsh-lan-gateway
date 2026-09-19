/**
 * Regression tests for the session races: a credential change landing while a
 * sign-in or a WebSocket handshake is in flight, and upstream answering a
 * handshake with something other than 101.
 *
 * Each of these exercises a window the earlier code left open. `verifyPassword`
 * is mocked to a controllable promise because the race is defined by *when* the
 * epoch advances relative to the check, and scrypt's real duration makes that
 * window unobservable from a test. The mock pauses the check; the state change
 * is real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { DEFAULT_LAN_CIDR_STRINGS } from '../../src/auth.ts'
import { LanGateway } from '../../src/gateway.ts'
import {
  setPassword,
  verifyPassword,
  type GatewayState,
} from '../../src/state.ts'
import type { UpstreamSession } from '../../src/upstream-session.ts'

vi.mock('../../src/state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state.ts')>()
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) }
})

const SECRET = 's'.repeat(32)
const PASSWORD = 'correct horse battery'
const SESSION_COOKIE = 'dsh_gw_auth'

/** A promise a test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

interface Upstream {
  server: http.Server
  port: number
  close: () => Promise<void>
}

/**
 * Wait for an upstream server to finish closing. An upgraded socket is detached
 * from the HTTP server the moment the `upgrade` event hands it over, so
 * `closeAllConnections()` does not reach it and `close()` would wait on it
 * forever — the sockets a test's `upgrade` handler received are destroyed here
 * explicitly.
 */
function closeServer(server: http.Server, upgraded: ReadonlySet<net.Socket>): Promise<void> {
  return new Promise((done) => {
    for (const socket of upgraded) socket.destroy()
    server.closeAllConnections()
    server.close(() => done())
  })
}

/**
 * An upstream that never answers an upgrade: it holds the socket open so the
 * gateway's own handshake path is what the test observes.
 */
function createSilentUpstream(): Promise<Upstream> {
  return new Promise((resolve) => {
    const upgraded = new Set<net.Socket>()
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end('UPSTREAM') })
    server.on('upgrade', (_req, socket: net.Socket) => {
      // Hold the socket, answer nothing: the gateway's own handshake path is
      // what the test observes.
      upgraded.add(socket)
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        close: () => closeServer(server, upgraded),
      })
    })
  })
}

/**
 * An upstream that completes the upgrade handshake and then holds the socket,
 * so a spliced connection is observable from the client.
 */
function createUpgradingUpstream(): Promise<Upstream> {
  return new Promise((resolve) => {
    const upgraded = new Set<net.Socket>()
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end('UPSTREAM') })
    server.on('upgrade', (_req, socket: net.Socket) => {
      upgraded.add(socket)
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n',
      )
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        close: () => closeServer(server, upgraded),
      })
    })
  })
}

/** An upstream that answers an upgrade with an ordinary HTTP status. */
function createRefusingUpstream(status: number, headers: http.OutgoingHttpHeaders): Promise<Upstream> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => { res.writeHead(status, headers); res.end('nope') })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        close: () => closeServer(server, new Set()),
      })
    })
  })
}

async function startGateway(
  state: GatewayState,
  upstreamPort: number,
  upstreamSession?: UpstreamSession,
): Promise<{ gateway: LanGateway; port: number }> {
  const gateway = new LanGateway({
    gatewayPort: 0,
    dshPort: upstreamPort,
    lanCidrs: DEFAULT_LAN_CIDR_STRINGS,
    lanPasswordless: false,
    cookieMaxAgeDays: 7,
    cookieName: SESSION_COOKIE,
    secureCookies: false,
    classifySource: () => 'internet',
    ...(upstreamSession !== undefined ? { upstreamSession } : {}),
  }, state)
  await gateway.listen()
  return { gateway, port: (gateway.server.address() as AddressInfo).port }
}

/** Post the login form. */
function login(port: number, password: string): Promise<{ status: number; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const body = `password=${encodeURIComponent(password)}`
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/__login',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.resume()
      res.on('end', () => {
        const raw = res.headers['set-cookie']
        resolve({
          status: res.statusCode ?? 0,
          setCookie: raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]),
        })
      })
    })
    request.on('error', reject)
    request.write(body)
    request.end()
  })
}

/** Perform a raw WebSocket-style upgrade and return everything read back. */
function rawUpgrade(port: number, cookie: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy() }, 3000)
    const finish = (): void => { clearTimeout(timer); resolve(buffer) }
    socket.on('connect', () => {
      socket.write([
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        `Cookie: ${cookie}`,
        `Origin: http://127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'))
    })
    socket.on('data', (chunk: Buffer) => { buffer += chunk.toString('utf8') })
    socket.on('close', finish)
    socket.on('error', finish)
  })
}

/** A signed session cookie for a state, minted the way the login route would. */
async function sessionCookieFor(state: GatewayState): Promise<string> {
  const { signCookie } = await import('../../src/auth.ts')
  const expiresMs = Date.now() + 3_600_000
  return `${SESSION_COOKIE}=${signCookie(state.cookieSecret, expiresMs, state.sessionEpoch, 'sid-1')}`
}

let upstream: Upstream | undefined
const open: Array<() => Promise<void>> = []

/**
 * Close a gateway without waiting on a spliced or held socket. Some of these
 * tests deliberately leave a connection open mid-handshake; `server.close()`
 * waits for its connections to end, so they are cut first.
 */
async function closeGateway(gateway: LanGateway): Promise<void> {
  gateway.server.closeAllConnections()
  await gateway.close()
}

beforeEach(() => {
  vi.mocked(verifyPassword).mockReset()
})

afterEach(async () => {
  for (const close of open.reverse()) await close()
  open.length = 0
  if (upstream !== undefined) await upstream.close()
  upstream = undefined
})

describe('a password change during sign-in', () => {
  it('refuses to mint a cookie for the epoch the check did not run under', async () => {
    const state = await setPassword({ cookieSecret: SECRET, sessionEpoch: 0 }, PASSWORD)
    upstream = await createSilentUpstream()
    const { gateway, port } = await startGateway(state, upstream.port)
    open.push(() => closeGateway(gateway))

    // Pause the check. The real scrypt call would resolve long before a test
    // could land the epoch bump, so the window has to be held open by hand.
    const gate = deferred<boolean>()
    vi.mocked(verifyPassword).mockImplementation(() => gate.promise)

    const pending = login(port, PASSWORD)
    await vi.waitFor(() => { expect(verifyPassword).toHaveBeenCalled() })

    // The credential moves while the check is in flight: a password change
    // advances the epoch, which is meant to retire every session.
    gateway.setState(await setPassword(state, 'a brand new password'))

    // The old password was correct — but correct under the previous epoch.
    gate.resolve(true)
    const response = await pending

    expect(response.status).toBe(401)
    expect(response.setCookie).toEqual([])
  })

  it('issues the cookie when nothing moved during the check', async () => {
    // The complement: without the interrupt the happy path must still sign in,
    // so the guard above cannot be passing by refusing everything.
    const state = await setPassword({ cookieSecret: SECRET, sessionEpoch: 0 }, PASSWORD)
    upstream = await createSilentUpstream()
    const { gateway, port } = await startGateway(state, upstream.port)
    open.push(() => closeGateway(gateway))

    vi.mocked(verifyPassword).mockImplementation(async () => true)
    const response = await login(port, PASSWORD)

    expect(response.status).toBe(302)
    expect(response.setCookie).toHaveLength(1)
    expect(response.setCookie[0]).toContain(`${SESSION_COOKIE}=`)
  })
})

describe('a credential change during a WebSocket handshake', () => {
  it('refuses to splice a handshake that was admitted before the epoch moved', async () => {
    const state = await setPassword({ cookieSecret: SECRET, sessionEpoch: 0 }, PASSWORD)
    upstream = await createSilentUpstream()
    const cookie = await sessionCookieFor(state)

    // The relay exchange is the await inside the handshake; holding it open is
    // what lets the revocation land mid-handshake.
    const gate = deferred<string | undefined>()
    let invalidated = 0
    const session: UpstreamSession = {
      cookie: () => gate.promise,
      invalidate: () => { invalidated += 1 },
    }
    const { gateway, port } = await startGateway(state, upstream.port, session)
    open.push(() => closeGateway(gateway))

    const pending = rawUpgrade(port, cookie)
    await vi.waitFor(() => { expect(invalidated).toBe(0) })
    // Give the handshake time to reach the relay await before revoking.
    await new Promise(resolve => setTimeout(resolve, 50))

    gateway.setState(await setPassword(state, 'a brand new password'))
    gate.resolve('dsh-auth-abc=relayed')

    const response = await pending
    // Not spliced: no 101 ever reaches the client. The socket is simply gone.
    expect(response).not.toContain('101')
    expect(response).not.toContain('Switching Protocols')
  })

  it('splices the handshake when no revocation lands', async () => {
    const state = await setPassword({ cookieSecret: SECRET, sessionEpoch: 0 }, PASSWORD)
    upstream = await createUpgradingUpstream()
    const cookie = await sessionCookieFor(state)
    const session: UpstreamSession = {
      cookie: async () => 'dsh-auth-abc=relayed',
      invalidate: () => {},
    }
    const { gateway, port } = await startGateway(state, upstream.port, session)
    open.push(() => closeGateway(gateway))

    const response = await rawUpgrade(port, cookie)
    expect(response).toContain('101 Switching Protocols')
    // The relayed session is not handed to the client on the success path
    // either: upstream answers the handshake, but 101 must not carry a cookie.
    expect(response).not.toContain('dsh-auth-abc=relayed')
  })
})

describe('an upstream that refuses the upgrade', () => {
  it('answers the client instead of leaving the socket parked', async () => {
    const state = await setPassword({ cookieSecret: SECRET, sessionEpoch: 0 }, PASSWORD)
    upstream = await createRefusingUpstream(404, { 'content-type': 'text/plain' })
    const cookie = await sessionCookieFor(state)
    const session: UpstreamSession = {
      cookie: async () => 'dsh-auth-abc=relayed',
      invalidate: () => {},
    }
    const { gateway, port } = await startGateway(state, upstream.port, session)
    open.push(() => closeGateway(gateway))

    const response = await rawUpgrade(port, cookie)
    // Without the non-101 branch node emits neither 'upgrade' nor 'error', and
    // the client waits on a socket that was never going to answer.
    expect(response).toContain('HTTP/1.1 404')
    expect(response).toContain('upstream refused the WebSocket upgrade')
  })

  it('drops the relayed session when upstream answers 401', async () => {
    const state = await setPassword({ cookieSecret: SECRET, sessionEpoch: 0 }, PASSWORD)
    upstream = await createRefusingUpstream(401, {})
    const cookie = await sessionCookieFor(state)
    let invalidated = 0
    const session: UpstreamSession = {
      cookie: async () => 'dsh-auth-abc=relayed',
      invalidate: () => { invalidated += 1 },
    }
    const { gateway, port } = await startGateway(state, upstream.port, session)
    open.push(() => closeGateway(gateway))

    const response = await rawUpgrade(port, cookie)
    expect(response).toContain('HTTP/1.1 401')
    // Otherwise a base that only ever sees WebSocket reconnects would replay a
    // dead session forever.
    expect(invalidated).toBe(1)
  })

  it('keeps the relayed session on a non-401 refusal', async () => {
    const state = await setPassword({ cookieSecret: SECRET, sessionEpoch: 0 }, PASSWORD)
    upstream = await createRefusingUpstream(404, {})
    const cookie = await sessionCookieFor(state)
    let invalidated = 0
    const session: UpstreamSession = {
      cookie: async () => 'dsh-auth-abc=relayed',
      invalidate: () => { invalidated += 1 },
    }
    const { gateway, port } = await startGateway(state, upstream.port, session)
    open.push(() => closeGateway(gateway))

    await rawUpgrade(port, cookie)
    expect(invalidated).toBe(0)
  })

  it('withholds the upstream session cookie from the client on the refusal', async () => {
    const state = await setPassword({ cookieSecret: SECRET, sessionEpoch: 0 }, PASSWORD)
    upstream = await createRefusingUpstream(401, { 'set-cookie': 'dsh-auth-abc=v1.sig' })
    const cookie = await sessionCookieFor(state)
    const session: UpstreamSession = {
      cookie: async () => 'dsh-auth-abc=relayed',
      invalidate: () => {},
    }
    const { gateway, port } = await startGateway(state, upstream.port, session)
    open.push(() => closeGateway(gateway))

    const response = await rawUpgrade(port, cookie)
    // The refusal path writes its own headers; upstream's Set-Cookie must not
    // ride along on it.
    expect(response).not.toContain('dsh-auth-abc=v1.sig')
  })
})
