/**
 * Integration tests for the real LanGateway server against a fake dsh
 * upstream. Exercises the acceptance matrix in the QVD-2026-57410 fix plan:
 * session-gated forwarding by source, the lanPasswordless exemption, owned-path
 * refusal, the same-site/Origin fence on HTTP and WS upgrades, cookie
 * attributes, session-epoch revocation, and the shared upstream-session relay.
 *
 * The gateway is exercised over real loopback sockets, but source IP is
 * injected through `classifySource` so a test can pose as a LAN or internet
 * client without binding different addresses.
 *
 * @module tests/integration/gateway
 */

import http from 'node:http'
import net from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LAN_CIDR_STRINGS, type SourceClass } from '../../src/auth.ts'
import { LanGateway } from '../../src/gateway.ts'
import { setPassword, type GatewayState } from '../../src/state.ts'
import type { UpstreamSession } from '../../src/upstream-session.ts'

/**
 * A state with a known password, ready to run a gateway. Hashing is
 * deliberately off the event loop now, so this is async — every call site
 * awaits it.
 */
async function authedState(): Promise<GatewayState> {
  return setPassword({ cookieSecret: 's'.repeat(32), sessionEpoch: 0 }, 'correct horse battery')
}

/** A state with no password (the gateway still runs; nobody can sign in). */
function credentiallessState(): GatewayState {
  return { cookieSecret: 's'.repeat(32), sessionEpoch: 0 }
}

/** A fake dsh upstream: records every request and lets a test drive responses. */
interface SeenRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
}

interface UpstreamHarness {
  server: http.Server
  port: number
  seen: SeenRequest[]
  /** Override the response for the next request(s). */
  respondNext: (status: number, body?: string, headers?: http.OutgoingHttpHeaders) => void
  close: () => Promise<void>
}

/** Keep a default responder that returns 200 "upstream" unless overridden. */
function createUpstream(): Promise<UpstreamHarness> {
  return new Promise((resolve) => {
    const seen: SeenRequest[] = []
    let responder: (req: http.IncomingMessage) => { status: number; body: string; headers: http.OutgoingHttpHeaders } =
      () => ({ status: 200, body: 'UPSTREAM', headers: { 'content-type': 'text/plain' } })
    const server = http.createServer((req, res) => {
      seen.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers })
      const { status, body, headers } = responder(req)
      res.writeHead(status, headers)
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        seen,
        respondNext(status, body = 'OVERRIDDEN', headers = {}) {
          responder = () => ({ status, body, headers })
        },
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

/** Start a LanGateway; resolves with its port. */
function startGateway(state: GatewayState, upstream: UpstreamHarness, opts: {
  lanPasswordless?: boolean
  secureCookies?: boolean
  source?: SourceClass
  upstreamSession?: UpstreamSession
} = {}): Promise<{ gateway: LanGateway; port: number }> {
  const source = opts.source ?? 'internet'
  const gateway = new LanGateway({
    gatewayPort: 0,
    dshPort: upstream.port,
    lanCidrs: DEFAULT_LAN_CIDR_STRINGS,
    lanPasswordless: opts.lanPasswordless ?? false,
    cookieMaxAgeDays: 7,
    cookieName: 'dsh_gw_auth',
    secureCookies: opts.secureCookies ?? false,
    classifySource: () => source,
    ...(opts.upstreamSession !== undefined ? { upstreamSession: opts.upstreamSession } : {}),
  }, state)
  return gateway.listen().then(() => ({ gateway, port: (gateway.server.address() as AddressInfo).port }))
}

interface HttpResponse {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** One HTTP request against the gateway (cookie jar optional). */
function req(port: number, method: string, path: string, opts: { cookie?: string; origin?: string; type?: string; body?: string; extra?: Record<string, string>; host?: string } = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: http.OutgoingHttpHeaders = { host: `127.0.0.1:${port}` }
    if (opts.cookie !== undefined) headers.cookie = opts.cookie
    if (opts.origin !== undefined) headers.origin = opts.origin
    if (opts.type !== undefined) headers['content-type'] = opts.type
    if (opts.body !== undefined) headers['content-length'] = Buffer.byteLength(opts.body)
    for (const [key, value] of Object.entries(opts.extra ?? {})) headers[key] = value
    const client = http.request({ host: opts.host ?? '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    client.on('error', reject)
    if (opts.body !== undefined) client.write(opts.body)
    client.end()
  })
}

/** Whether this host has IPv6 loopback at all (the listener falls back to IPv4 without it). */
function ipv6Available(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => { resolve(false) })
    probe.listen(0, '::1', () => { probe.close(() => resolve(true)) })
  })
}

/** Perform a raw WebSocket-style upgrade handshake; returns everything read. */
function rawUpgrade(port: number, path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    let buf = ''
    const timer = setTimeout(() => { socket.destroy() }, 2000)
    socket.on('connect', () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`]
      for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`)
      lines.push('Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', '')
      socket.write(lines.join('\r\n'))
    })
    socket.on('data', (d: Buffer) => { buf += d.toString('utf8') })
    socket.on('close', () => { clearTimeout(timer); resolve(buf) })
    socket.on('error', () => { clearTimeout(timer); resolve(buf) })
  })
}

/** The `name=value` portion of every set-cookie, for building a cookie jar. */
function cookieJar(headers: IncomingHttpHeaders): string {
  const raw = headers['set-cookie']
  if (raw === undefined) return ''
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((value) => value.split(';')[0]).join('; ')
}

/** The raw Set-Cookie attribute string (for attribute assertions). */
function setCookieValues(headers: IncomingHttpHeaders): string[] {
  const raw = headers['set-cookie']
  return raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw])
}

const LOGIN = '/__login'
const LOGOUT = '/__logout'

async function login(port: number, password: string): Promise<HttpResponse> {
  return req(port, 'POST', LOGIN, {
    type: 'application/x-www-form-urlencoded',
    body: `password=${encodeURIComponent(password)}`,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('LanGateway end-to-end against a fake upstream', () => {
  it('row 1: a loopback source with no session is bounced to /__login, nothing forwarded', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'loopback' })
    try {
      const res = await req(port, 'GET', '/')
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe(LOGIN)
      expect(upstream.seen).toHaveLength(0)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('rows 2–3: LAN and internet sources with no session are bounced to /__login by default', async () => {
    for (const source of ['lan', 'internet'] as const) {
      const upstream = await createUpstream()
      const { gateway, port } = await startGateway(await authedState(), upstream, { source })
      try {
        const res = await req(port, 'GET', '/')
        expect(res.status).toBe(302)
        expect(res.headers.location).toBe(LOGIN)
        expect(upstream.seen).toHaveLength(0)
      } finally {
        await gateway.close()
        await upstream.close()
      }
    }
  })

  it('row 4: lanPasswordless lets a LAN source straight through, but only LAN', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, {
      lanPasswordless: true,
      source: 'lan',
    })
    try {
      const res = await req(port, 'GET', '/')
      expect(res.status).toBe(200)
      expect(res.body).toBe('UPSTREAM')
      expect(upstream.seen).toHaveLength(1)
    } finally {
      await gateway.close()
      await upstream.close()
    }

    // The same exemption must NOT extend to internet sources.
    const upstream2 = await createUpstream()
    const { gateway: gw2, port: port2 } = await startGateway(await authedState(), upstream2, {
      lanPasswordless: true,
      source: 'internet',
    })
    try {
      const res = await req(port2, 'GET', '/')
      expect(res.status).toBe(302)
      expect(upstream2.seen).toHaveLength(0)
    } finally {
      await gw2.close()
      await upstream2.close()
    }
  })

  it('row 6: a valid session cannot ride a cross-site Origin', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const issued = await login(port, 'correct horse battery')
      expect(issued.status).toBe(302)
      const jar = cookieJar(issued.headers)

      const cross = await req(port, 'GET', '/api/chat', { cookie: jar, origin: 'http://evil.example' })
      expect(cross.status).toBe(403)
      expect(upstream.seen).toHaveLength(0)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 7: an upgrade without a same-site Origin is refused even with a session', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)

      // Browsers always send an Origin on upgrades; its absence is a non-browser
      // cross-site attempt.
      const noOrigin = await rawUpgrade(port, '/api/remote.mux', { cookie: jar })
      expect(noOrigin).toMatch(/^HTTP\/1\.1 403 /)

      const crossOrigin = await rawUpgrade(port, '/api/remote.mux', { cookie: jar, origin: 'http://evil.example' })
      expect(crossOrigin).toMatch(/^HTTP\/1\.1 403 /)

      expect(upstream.seen).toHaveLength(0)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 7b: an unauthorized upgrade is refused with 401, not forwarded', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const res = await rawUpgrade(port, '/api/remote.mux', { origin: `http://127.0.0.1:${port}` })
      expect(res).toMatch(/^HTTP\/1\.1 401 /)
      expect(upstream.seen).toHaveLength(0)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 8: an API path is session-gated too (no passwordless prefix survives)', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const res = await req(port, 'GET', '/api/chat')
      expect(res.status).toBe(302)
      expect(upstream.seen).toHaveLength(0)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 9: the owned /lan-gateway/config prefix is refused even with a session and never reaches upstream', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)
      const res = await req(port, 'GET', '/lan-gateway/config', { cookie: jar })
      expect(res.status).toBe(403)
      expect(res.body).toContain('forbidden')
      expect(upstream.seen).toHaveLength(0)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 9b: a dot-segment spelling of the owned path is refused too, on HTTP and WS', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)

      // The gateway routes by the same WHATWG-normalized path dsh's router
      // uses; a raw-string prefix test would let these through to the relay,
      // where Host is rewritten to loopback and the plugin's own config route
      // accepts them.
      for (const path of [
        '/foo/../lan-gateway/config',
        '/./lan-gateway/config',
        '/a/b/../../lan-gateway/config',
      ]) {
        const res = await req(port, 'GET', path, { cookie: jar })
        expect(res.status, path).toBe(403)
      }

      const upgraded = await rawUpgrade(port, '/foo/../lan-gateway/config', {
        cookie: jar,
        origin: `http://127.0.0.1:${port}`,
      })
      expect(upgraded).toMatch(/^HTTP\/1\.1 403 /)

      expect(upstream.seen).toHaveLength(0)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 9c: normalization does not over-block — an ordinary path still relays verbatim', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)
      const res = await req(port, 'GET', '/a/../api/chat', { cookie: jar })
      expect(res.status).toBe(200)
      // Forwarding relays the raw target; dsh normalizes it the same way.
      expect(upstream.seen[0]!.url).toBe('/a/../api/chat')
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 9d: a trailing slash does not route the gateway\'s own surfaces into the relay', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      // The login page, not dsh's single-page fallback.
      const form = await req(port, 'GET', '/__login/')
      expect(form.status).toBe(200)
      expect(form.body).toContain('name="password"')

      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)

      // The owned prefix is refused rather than relayed with Host rewritten to
      // loopback, where the plugin's own config route would answer it.
      const owned = await req(port, 'GET', '/lan-gateway/config/', { cookie: jar })
      expect(owned.status).toBe(403)

      // And a trailing slash still signs out rather than falling through to
      // dsh, where POST /__logout/ would be nothing but a 404.
      const out = await req(port, 'POST', '/__logout/', {
        cookie: jar,
        origin: `http://127.0.0.1:${port}`,
      })
      expect(out.status).toBe(302)
      expect((await req(port, 'GET', '/', { cookie: jar })).status).toBe(302)

      expect(upstream.seen).toHaveLength(0)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('signing out revokes the session that signed out, and only that one', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const first = await login(port, 'correct horse battery')
      const second = await login(port, 'correct horse battery')
      const jarA = cookieJar(first.headers)
      const jarB = cookieJar(second.headers)
      // Every login mints its own session id, so the two are independently
      // revocable. (They differ as values too: the id is part of the payload.)
      expect(jarA).not.toBe(jarB)
      expect((await req(port, 'GET', '/', { cookie: jarA })).status).toBe(200)

      const out = await req(port, 'POST', LOGOUT, {
        cookie: jarA,
        origin: `http://127.0.0.1:${port}`,
      })
      expect(out.status).toBe(302)

      // Clearing the browser's cookie is not the point: a replay of the same
      // value is refused from now on, without an epoch bump to do it.
      const replayed = await req(port, 'GET', '/', { cookie: jarA })
      expect(replayed.status).toBe(302)
      expect(replayed.headers.location).toBe(LOGIN)

      // The other session is untouched — signing out is not a global revoke.
      const other = await req(port, 'GET', '/', { cookie: jarB })
      expect(other.status).toBe(200)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('signing out without a session is a no-op, not an error', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const out = await req(port, 'POST', LOGOUT, { origin: `http://127.0.0.1:${port}` })
      expect(out.status).toBe(302)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('reaches IPv6 loopback clients on the same port', async (ctx) => {
    // The listener binds the unspecified address, which node resolves to `::`
    // (dual-stack) where IPv6 exists and to 0.0.0.0 where it does not. Without
    // it, a gateway that classifies `::1` and `fe80::` can never be reached
    // over either.
    if (!await ipv6Available()) ctx.skip()
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const res = await req(port, 'GET', '/', { host: '::1' })
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe(LOGIN)
      expect(upstream.seen).toHaveLength(0)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 12: a correct login mints a session cookie with the right attributes and forwards', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, {
      source: 'internet',
      secureCookies: true,
    })
    try {
      const issued = await login(port, 'correct horse battery')
      expect(issued.status).toBe(302)
      const values = setCookieValues(issued.headers)
      expect(values).toHaveLength(1)
      const cookie = values[0]!
      expect(cookie).toContain('dsh_gw_auth=')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Strict')
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('Path=/')

      // Authenticated read (navigation-like, no Origin) is forwarded and the
      // Host is rewritten to the loopback upstream.
      const jar = cookieJar(issued.headers)
      const ok = await req(port, 'GET', '/', { cookie: jar })
      expect(ok.status).toBe(200)
      expect(ok.body).toBe('UPSTREAM')
      expect(upstream.seen).toHaveLength(1)
      expect(upstream.seen[0]!.headers.host).toBe(`127.0.0.1:${upstream.port}`)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 12b: over plaintext (no Secure), the cookie omits Secure but keeps the rest', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, {
      source: 'internet',
      secureCookies: false,
    })
    try {
      const issued = await login(port, 'correct horse battery')
      const values = setCookieValues(issued.headers)
      expect(values[0]).toContain('HttpOnly')
      expect(values[0]).toContain('SameSite=Strict')
      expect(values[0]).not.toContain('Secure')
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 12c: wrong password is refused with 401 and the account rate-limits after 5 tries', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const bad = await login(port, 'not the password')
        expect(bad.status).toBe(401)
      }
      const limited = await login(port, 'correct horse battery')
      expect(limited.status).toBe(401) // correct password still blocked while limited
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 6b: a state-changing forwarded request without an Origin is refused even with a session', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)

      // A non-browser client that holds the cookie but sends no Origin cannot
      // mutate state: without dsh's own CSRF fence (which the loopback rewrite
      // blinds) this is the gateway's defense against form/script CSRF.
      const res = await req(port, 'POST', '/api/chat', { cookie: jar })
      expect(res.status).toBe(403)
      expect(upstream.seen).toHaveLength(0)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 12d: a read-only request with no Origin but a valid session is forwarded (navigation-like)', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)
      const ok = await req(port, 'GET', '/', { cookie: jar })
      expect(ok.status).toBe(200)
      expect(upstream.seen).toHaveLength(1)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('row 13: bumping the session epoch immediately invalidates issued cookies', async () => {
    const upstream = await createUpstream()
    let state = await authedState()
    const gateway = new LanGateway({
      gatewayPort: 0,
      dshPort: upstream.port,
      lanCidrs: DEFAULT_LAN_CIDR_STRINGS,
      lanPasswordless: false,
      cookieMaxAgeDays: 7,
      cookieName: 'dsh_gw_auth',
      secureCookies: false,
      classifySource: () => 'internet',
    }, state)
    const port = await new Promise<number>((resolve) => {
      gateway.server.listen(0, '0.0.0.0', () => resolve((gateway.server.address() as AddressInfo).port))
    })
    try {
      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)
      const ok = await req(port, 'GET', '/', { cookie: jar })
      expect(ok.status).toBe(200)

      // Simulate the plugin rotating the secret / password: epoch advances.
      state = { cookieSecret: 's'.repeat(32), sessionEpoch: state.sessionEpoch + 1 }
      gateway.setState(state)

      const after = await req(port, 'GET', '/', { cookie: jar })
      expect(after.status).toBe(302) // old cookie now dead
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('relays a shared upstream session cookie and drops it when upstream 401s', async () => {
    const upstream = await createUpstream()
    const invalidate = vi.fn()
    const session: UpstreamSession = {
      cookie: async () => 'dsh-auth-abc123=relayed-session',
      invalidate,
    }
    const { gateway, port } = await startGateway(await authedState(), upstream, {
      source: 'internet',
      upstreamSession: session,
    })
    try {
      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)
      const ok = await req(port, 'GET', '/', { cookie: jar })
      expect(ok.status).toBe(200)
      expect(upstream.seen).toHaveLength(1)
      // The browser's own cookie AND the relayed upstream session both ride the
      // outbound request.
      expect(upstream.seen[0]!.headers.cookie).toContain('dsh-auth-abc123=relayed-session')
      expect(upstream.seen[0]!.headers.cookie).toContain('dsh_gw_auth=')

      // Upstream revokes the session → gateway forgets it so the next request
      // re-acquires through the launch-token exchange.
      upstream.respondNext(401)
      const rejected = await req(port, 'GET', '/', { cookie: jar })
      expect(rejected.status).toBe(401)
      expect(invalidate).toHaveBeenCalledTimes(1)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('a client-held dsh-auth cookie cannot shadow the relayed session', async () => {
    const upstream = await createUpstream()
    const session: UpstreamSession = {
      cookie: async () => 'dsh-auth-abc123=relayed-session',
      invalidate: vi.fn(),
    }
    const { gateway, port } = await startGateway(await authedState(), upstream, {
      source: 'internet',
      upstreamSession: session,
    })
    try {
      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)
      // The client still holds a same-named cookie from before upstream's
      // signing secret was reset: present, unexpired, no longer verifying.
      // Upstream reads the first name match, so relaying it would 401 forever
      // while the gateway kept re-acquiring a session that was never used.
      const res = await req(port, 'GET', '/', { cookie: `${jar}; dsh-auth-abc123=stale-client-session` })
      expect(res.status).toBe(200)

      const forwarded = upstream.seen[0]!.headers.cookie!
      expect(forwarded).not.toContain('stale-client-session')
      expect(forwarded).toContain('dsh-auth-abc123=relayed-session')
      expect(forwarded).toContain('dsh_gw_auth=')
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('withholds the upstream session cookie from relayed responses, keeps other cookies', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)
      // A gated client posting the launch token through the gateway must not
      // be able to walk away with a durable upstream credential.
      upstream.respondNext(303, '', {
        location: '/',
        'set-cookie': [
          'dsh-auth-abc123=minted-upstream-session; HttpOnly; Path=/',
          'some_plugin_cookie=keepme; Path=/',
        ],
        'keep-alive': 'timeout=5, max=1000',
        'proxy-authenticate': 'Basic realm="upstream"',
      })
      const res = await req(port, 'GET', '/?token=exfiltrate-me', { cookie: jar })
      expect(res.status).toBe(303)

      const cookies = setCookieValues(res.headers)
      expect(cookies.some((value) => value.startsWith('dsh-auth-'))).toBe(false)
      expect(cookies.some((value) => value.startsWith('some_plugin_cookie=keepme'))).toBe(true)

      // Hop-by-hop response headers are not forwarded either. (keep-alive is
      // not asserted: node's own server layer emits one regardless.)
      expect(res.headers['proxy-authenticate']).toBeUndefined()
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('does not relay client-supplied forwarding headers upstream', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)
      const res = await req(port, 'GET', '/', {
        cookie: jar,
        extra: {
          'x-forwarded-for': '203.0.113.9',
          'x-forwarded-proto': 'https',
          'x-real-ip': '203.0.113.9',
          forwarded: 'for=203.0.113.9',
        },
      })
      expect(res.status).toBe(200)
      const forwarded = upstream.seen[0]!.headers
      expect(forwarded['x-forwarded-for']).toBeUndefined()
      expect(forwarded['x-forwarded-proto']).toBeUndefined()
      expect(forwarded['x-real-ip']).toBeUndefined()
      expect(forwarded.forwarded).toBeUndefined()
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('forwards without any session when no upstreamSession is wired (older base)', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(await authedState(), upstream, { source: 'internet' })
    try {
      const issued = await login(port, 'correct horse battery')
      const jar = cookieJar(issued.headers)
      const ok = await req(port, 'GET', '/', { cookie: jar })
      expect(ok.status).toBe(200)
      expect(upstream.seen[0]!.headers.cookie).toBe(jar)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })

  it('a session cannot be minted when no password is set', async () => {
    const upstream = await createUpstream()
    const { gateway, port } = await startGateway(credentiallessState(), upstream, { source: 'internet' })
    try {
      const res = await login(port, 'anything')
      expect(res.status).toBe(401)
    } finally {
      await gateway.close()
      await upstream.close()
    }
  })
})
