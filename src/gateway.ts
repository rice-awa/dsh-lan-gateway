/**
 * The reverse-proxy gateway: a `node:http(s)` server bound to `0.0.0.0` that
 * forwards every request to the loopback dsh web server.
 *
 * Security model (post-QVD / session-base):
 * - Source is classified from `socket.remoteAddress` only (never
 *   `X-Forwarded-For`). Classification alone grants nothing: by default every
 *   source — loopback, LAN, internet — must present a valid gateway session.
 *   `lanPasswordless` (an explicit opt-in, false by default) is the one way a
 *   LAN/loopback source skips the gateway login, and it is only ever allowed
 *   against a session-capable dsh base (enforced by the plugin, which owns the
 *   fail-closed guard).
 * - The gateway never forwards its own management surface (`/lan-gateway/*`)
 *   or its login/logout paths; those are handled locally or refused.
 * - Because this gateway rewrites Origin to loopback, dsh's own CSRF fence is
 *   blinded — so the gateway runs its own origin check on every relayed
 *   request (HTTP and WebSocket upgrade) BEFORE rewriting: reject
 *   `sec-fetch-site: cross-site`, reject any Origin that does not name the
 *   gateway authority the browser actually used, and require an Origin on
 *   state-changing methods and on every WebSocket upgrade.
 * - Against a session-capable dsh base the Host/Origin rewrite alone would
 *   still earn a 401 (dsh no longer trusts a loopback Host; it demands its own
 *   authority-bound session cookie). The gateway therefore relays one shared
 *   upstream session acquired through the launch-token exchange and replays it
 *   on every forwarded request. See `upstream-session.ts`.
 * - Sessions carry a revocation epoch: a password change or secret rotation
 *   bumps the epoch, every previously issued cookie dies, and established
 *   WebSockets are torn down so the client re-authenticates.
 *
 * @module @riceawa/dsh-lan-gateway/gateway
 */

import http from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import {
  classifySource,
  originMatchesHost,
  RateLimiter,
  signCookie,
  verifyCookie,
  type SourceClass,
} from './auth.ts'
import {
  LOGIN_PATH,
  LOGOUT_PATH,
  readBody,
  renderLoginPage,
  serveLoginGet,
  type LoginPageOptions,
} from './login.ts'
import { verifyPassword, type GatewayState } from './state.ts'
import type { UpstreamSession } from './upstream-session.ts'

/** Configuration the gateway needs at listen time. */
export interface GatewayConfig {
  /** Port to bind on 0.0.0.0. */
  gatewayPort: number
  /** The loopback dsh web server port to forward to. */
  dshPort: number
  /** LAN CIDRs that may be treated as trusted (descriptive; see `lanPasswordless`). */
  lanCidrs: readonly string[]
  /** Whether LAN/loopback sources may skip the gateway login (explicit opt-in). */
  lanPasswordless: boolean
  /** Cookie lifetime in days. */
  cookieMaxAgeDays: number
  /** Cookie name. */
  cookieName: string
  /** Whether the ingress is encrypted (self TLS or a declared trusted terminator); adds `Secure` to cookies. */
  secureCookies: boolean
  /** PEM cert/key material; when present the listener speaks HTTPS (and sends HSTS). */
  tls?: { cert: string; key: string }
  /** Optional injectable source classifier (integration tests emulate LAN/internet). */
  classifySource?: (req: http.IncomingMessage) => SourceClass
  /** Optional shared upstream session relayed onto every forwarded request. */
  upstreamSession?: UpstreamSession
}

const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024
const LOGIN_ATTEMPTS_LIMIT = 5
const LOGIN_ATTEMPTS_WINDOW_MS = 60_000

/** Methods a browser never attaches a CSRF-meaningful body to; safe without an Origin. */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** The upstream browser-session cookie name prefix; the relay owns this namespace. */
const UPSTREAM_COOKIE_PREFIX = 'dsh-auth-'

/**
 * Headers a proxy must not forward in either direction (RFC 9110 §7.6.1), plus
 * the non-standard proxy-connection.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Headers by which a client asserts where a request came from. The gateway
 * classifies on `socket.remoteAddress` and never reads these, so relaying a
 * caller's own values only hands the next hop a forgeable claim.
 */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
]

/** Whether a Cookie fragment names the upstream session cookie. */
function isUpstreamSessionPair(pair: string): boolean {
  return pair.startsWith(UPSTREAM_COOKIE_PREFIX)
}

/**
 * Drop every `dsh-auth-*` pair from a Cookie header, returning the remainder
 * (possibly '').
 *
 * `attachUpstreamSession` appends the relay's session to the client's own
 * cookie, and upstream reads the FIRST name match. A client that holds any
 * `dsh-auth-<hash>` — typically one minted before dsh's signing secret was
 * reset, so still present but no longer verifying — would therefore shadow the
 * relay's session on every request. That draws a 401, the gateway reads the
 * 401 as "upstream revoked our session" and discards it, the next request
 * re-acquires, and the client's stale cookie shadows that one too: a loop that
 * never converges. Stripping the namespace makes the relay's copy the only one.
 */
function withoutUpstreamSessionPairs(cookie: string): string {
  return cookie
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '' && !isUpstreamSessionPair(pair))
    .join('; ')
}

/** Prefixes the gateway owns and must never relay to dsh. */
function isOwnedPath(pathname: string): boolean {
  return pathname === '/lan-gateway' || pathname.startsWith('/lan-gateway/')
}

/**
 * The pathname a request is routed by, resolved the way dsh's router resolves
 * it: WHATWG URL parsing, which strips the query and collapses dot segments.
 *
 * The decision paths below (owned prefix, login, logout) must use this rather
 * than the raw request target. dsh normalizes before matching, so a raw-string
 * test disagrees with it on `/foo/../lan-gateway/config` — that is not an owned
 * path by string prefix, stays in the relay, and lands on the plugin's own
 * config route once Host has been rewritten to loopback. Forwarding still
 * relays the raw target: dsh applies the same normalization itself.
 */
function pathOf(url: string): string {
  try {
    return new URL(url, 'http://gateway.invalid').pathname
  } catch {
    // Unparseable here means unparseable for dsh too; the raw target routes
    // nowhere and is relayed as-is.
    return url
  }
}

/**
 * The running gateway: owns the HTTP server and the auth state needed per
 * request. Created by the plugin on enable; torn down by the plugin on
 * disable or tree disposal.
 */
export class LanGateway {
  readonly server: http.Server
  private readonly loginLimiter = new RateLimiter(LOGIN_ATTEMPTS_LIMIT, LOGIN_ATTEMPTS_WINDOW_MS)
  private state: GatewayState
  private disposed = false
  /** Established WebSockets (upgraded client sockets), torn down on session-epoch change. */
  private readonly activeDuplexes = new Set<Duplex>()

  constructor(
    private readonly config: GatewayConfig,
    state: GatewayState,
  ) {
    this.state = state
    const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      void this.handleHttp(req, res)
    }
    this.server = this.config.tls !== undefined
      ? https.createServer({ cert: this.config.tls.cert, key: this.config.tls.key }, handle)
      : http.createServer(handle)
    this.server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head)
    })
  }

  /** Replace the in-memory state; bumps of `sessionEpoch` revoke live sessions and sockets. */
  setState(state: GatewayState): void {
    if (state.sessionEpoch !== this.state.sessionEpoch) {
      this.destroyActiveDuplexes()
    }
    this.state = state
  }

  /** Start listening; rejects if the port is already in use. */
  async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.config.gatewayPort, '0.0.0.0')
    })
  }

  /** Close the server, drop upgraded sockets, and stop accepting connections. */
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.destroyActiveDuplexes()
    return new Promise((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  private destroyActiveDuplexes(): void {
    for (const socket of this.activeDuplexes) {
      socket.destroy()
    }
    this.activeDuplexes.clear()
  }

  private trackDuplex(socket: Duplex): void {
    this.activeDuplexes.add(socket)
    socket.on('close', () => {
      this.activeDuplexes.delete(socket)
    })
  }

  private sourceOf(req: http.IncomingMessage): SourceClass {
    return this.config.classifySource !== undefined
      ? this.config.classifySource(req)
      : classifySource(req.socket.remoteAddress, this.config.lanCidrs)
  }

  /** Parse the session cookie out of a Cookie header. */
  private sessionCookie(req: http.IncomingMessage): string | undefined {
    const header = req.headers.cookie
    if (typeof header !== 'string') return undefined
    for (const part of header.split(';')) {
      const trimmed = part.trim()
      if (trimmed.startsWith(`${this.config.cookieName}=`)) {
        return trimmed.slice(this.config.cookieName.length + 1)
      }
    }
    return undefined
  }

  /** Whether a request carries a session valid under the current epoch. */
  private authorized(req: http.IncomingMessage): boolean {
    const cookie = this.sessionCookie(req)
    return cookie !== undefined && verifyCookie(
      this.state.cookieSecret,
      cookie,
      Date.now(),
      this.state.sessionEpoch,
    )
  }

  /** Whether this source must present a gateway session (default: everyone). */
  private requiresLogin(source: SourceClass): boolean {
    return !(this.config.lanPasswordless && source !== 'internet')
  }

  private serveUnauthorized(res: http.ServerResponse, limited: boolean): void {
    res.writeHead(302, {
      location: `${LOGIN_PATH}${limited ? '?limited=1' : ''}`,
      ...this.securityHeaders(),
    })
    res.end()
  }

  private serveLoginError(res: http.ServerResponse, message: string): void {
    const opts: LoginPageOptions = { error: message }
    res.writeHead(401, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...this.securityHeaders(),
    })
    res.end(renderLoginPage(opts))
  }

  /** HSTS when the listener itself is HTTPS (never sent on plain HTTP). */
  private securityHeaders(): http.OutgoingHttpHeaders {
    return this.config.tls === undefined
      ? {}
      : { 'strict-transport-security': 'max-age=15552000' }
  }

  /**
   * The gateway's own cross-site gate, shared by HTTP and WebSocket upgrades
   * and applied before any Host/Origin rewriting. Browsers attach Origin to
   * state-changing requests and to every WebSocket handshake; reads without an
   * Origin (navigations, non-browser clients holding a session) stay allowed.
   */
  private sameSiteAllowed(req: http.IncomingMessage, upgrade: boolean): boolean {
    const headers = req.headers
    if (headers['sec-fetch-site'] === 'cross-site') return false
    const origin = headers.origin
    const host = headers.host
    if (origin !== undefined && !originMatchesHost(origin, host)) return false
    if (upgrade) return origin !== undefined
    if (!READ_ONLY_METHODS.has(req.method ?? 'GET')) return origin !== undefined
    return true
  }

  private sessionSetCookie(value: string, maxAgeSeconds: number): string {
    const attributes = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`
    return `${this.config.cookieName}=${value}; ${attributes}${this.config.secureCookies ? '; Secure' : ''}`
  }

  /** Handle one HTTP request: anonymous allowlist → owned-path refuse → session gate → same-site gate → relay. */
  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    const pathname = pathOf(url)
    const source = this.sourceOf(req)

    if (pathname === LOGIN_PATH) {
      this.handleLogin(req, res)
      return
    }
    if (pathname === LOGOUT_PATH) {
      this.handleLogout(req, res)
      return
    }

    // The gateway's own management surface never reaches dsh: an unauthenticated
    // remote request must not be able to touch the loopback-only config route by
    // having the gateway rewrite Host to loopback for it.
    if (isOwnedPath(pathname)) {
      res.writeHead(403, this.securityHeaders())
      res.end('forbidden')
      return
    }

    if (this.requiresLogin(source) && !this.authorized(req)) {
      this.serveUnauthorized(res, false)
      return
    }

    if (!this.sameSiteAllowed(req, false)) {
      res.writeHead(403, this.securityHeaders())
      res.end('forbidden')
      return
    }

    await this.relayHttp(req, res, url)
  }

  /** Handle the login GET form / POST submission. */
  private handleLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
    const limited = req.url?.includes('limited=1') ?? false
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveLoginGet(res, this.securityHeaders())
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' })
      res.end()
      return
    }

    const key = req.socket.remoteAddress ?? 'unknown'
    if (!this.loginLimiter.allow(key)) {
      this.serveLoginError(res, 'Too many attempts — please wait a minute.')
      return
    }

    void readBody(req, DEFAULT_BODY_LIMIT_BYTES, res).then(async (body) => {
      if (body === undefined) return // response already sent (413/400)
      let password: string | undefined
      try {
        const fields = new URLSearchParams(body)
        password = fields.get('password') ?? undefined
      } catch {
        password = undefined
      }
      const accepted = password !== undefined && await verifyPassword(this.state, password)
      if (!accepted) {
        this.serveLoginError(res, 'Incorrect password.')
        return
      }
      const maxAgeSeconds = this.config.cookieMaxAgeDays * 86_400
      const expiresMs = Date.now() + maxAgeSeconds * 1000
      const cookie = signCookie(this.state.cookieSecret, expiresMs, this.state.sessionEpoch)
      res.writeHead(302, {
        location: '/',
        ...this.securityHeaders(),
        'set-cookie': [this.sessionSetCookie(cookie, maxAgeSeconds)],
      })
      res.end()
    }).catch(() => {
      // The body reader reports its own failures through the response; this
      // catches the async verification path so it cannot become an unhandled
      // rejection.
      if (!res.headersSent) {
        res.writeHead(500, this.securityHeaders())
        res.end('login failed')
      }
    })
  }

  /** POST /__logout: sign an immediately-expired cookie and bounce to / . */
  private handleLogout(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    // A logout is a state change: refuse cross-site triggers.
    if (!this.sameSiteAllowed(req, false)) {
      res.writeHead(403, this.securityHeaders())
      res.end('forbidden')
      return
    }
    res.writeHead(302, {
      location: '/',
      ...this.securityHeaders(),
      'set-cookie': [this.sessionSetCookie('', 0)],
    })
    res.end()
  }

  /** Build the outbound headers: rewrite Host/Origin to the loopback upstream. */
  private upstreamHeaders(req: http.IncomingMessage, keepUpgrade: boolean): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...req.headers }
    headers.host = `127.0.0.1:${this.config.dshPort}`
    if (typeof headers.origin === 'string') {
      headers.origin = `http://127.0.0.1:${this.config.dshPort}`
    }
    // Hop-by-hop headers the gateway must not forward.
    delete headers['proxy-connection']
    if (!keepUpgrade) {
      delete headers.connection
      delete headers.upgrade
    }
    // A caller's own forwarding claims are not ours to relay.
    for (const name of FORWARDING_HEADERS) delete headers[name]
    // The relay is the only authority on the upstream session cookie.
    if (typeof headers.cookie === 'string') {
      const kept = withoutUpstreamSessionPairs(headers.cookie)
      if (kept === '') delete headers.cookie
      else headers.cookie = kept
    }
    return headers
  }

  /** Attach the shared upstream session cookie to the outbound headers, if any. */
  private attachUpstreamSession(headers: http.OutgoingHttpHeaders): boolean {
    const session = this.config.upstreamSession
    if (session === undefined) return false
    const cookie = session.peek()
    if (cookie === undefined) return false
    const existing = headers.cookie
    headers.cookie = typeof existing === 'string' && existing !== ''
      ? `${existing}; ${cookie}`
      : cookie
    return true
  }

  /**
   * The headers to send back to the client: hop-by-hop headers dropped, and
   * the upstream session cookie withheld. Upstream's one cookie-minting route
   * is the launch-token exchange at `/`, so a client that already holds a
   * gateway session could otherwise post the token through the gateway and
   * walk away with a durable upstream credential the relay exists to keep on
   * this side. Cookies from other routes (plugins) still pass through.
   */
  private downstreamHeaders(upstream: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {}
    for (const [key, value] of Object.entries(upstream)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (HOP_BY_HOP_HEADERS.has(lower)) continue
      if (lower === 'set-cookie') {
        const list = (Array.isArray(value) ? value : [value])
          .filter((entry) => !isUpstreamSessionPair(entry.trim()))
        if (list.length > 0) headers[key] = list
        continue
      }
      headers[key] = value
    }
    return headers
  }

  /** Forward an HTTP request to dsh, replaying the shared upstream session. */
  private async relayHttp(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<void> {
    const session = this.config.upstreamSession
    if (session !== undefined) await session.cookie()
    const headers = this.upstreamHeaders(req, false)
    const attached = this.attachUpstreamSession(headers)

    const proxyReq = http.request({
      host: '127.0.0.1',
      port: this.config.dshPort,
      method: req.method,
      path: url,
      headers,
    }, (proxyRes) => {
      // A 401 while we relayed an upstream session means upstream revoked it
      // (secret/epoch change on its side): drop our copy so the next request
      // re-acquires through the launch-token exchange.
      if (attached && session !== undefined && proxyRes.statusCode === 401) {
        session.invalidate()
      }
      res.writeHead(proxyRes.statusCode ?? 502, this.downstreamHeaders(proxyRes.headers))
      proxyRes.pipe(res)
    })
    proxyReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502)
      }
      res.destroy()
    })
    req.pipe(proxyReq)
  }

  /** Forward a WebSocket upgrade through the same gates, splicing the duplex to dsh. */
  private async handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = req.url ?? '/'
    const pathname = pathOf(url)
    const source = this.sourceOf(req)

    const refuse = (status: number): void => {
      socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
    }

    // Login/logout and the gateway's own surface are not upgrade targets.
    if (pathname === LOGIN_PATH || pathname === LOGOUT_PATH || isOwnedPath(pathname)) {
      refuse(403)
      return
    }

    if (this.requiresLogin(source) && !this.authorized(req)) {
      refuse(401)
      return
    }

    // Upgrades are state changes that only browsers meaningfully make: require
    // a same-origin Origin so a cross-site page cannot open a socket that rides
    // the requester's ambient session.
    if (!this.sameSiteAllowed(req, true)) {
      refuse(403)
      return
    }

    const session = this.config.upstreamSession
    if (session !== undefined) await session.cookie()
    const headers = this.upstreamHeaders(req, true)
    this.attachUpstreamSession(headers)

    const proxyReq = http.request({
      host: '127.0.0.1',
      port: this.config.dshPort,
      method: 'GET',
      path: url,
      headers,
    })
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      this.trackDuplex(socket)
      // node's http client has already consumed the 101 response headers, so
      // reconstruct them on the client socket before splicing.
      const statusLine = `HTTP/1.1 ${proxyRes.statusCode ?? 101} ${proxyRes.statusMessage ?? 'Switching Protocols'}\r\n`
      const headerLines = Object.entries(proxyRes.headers)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`)
        .join('')
      socket.write(`${statusLine}${headerLines}\r\n`)
      // Forward the client's own head bytes (initial WebSocket frames) to dsh.
      if (head !== undefined && head.length > 0) {
        proxySocket.write(head)
      }
      proxySocket.pipe(socket).pipe(proxySocket)
      if (proxyHead !== undefined && proxyHead.length > 0) {
        proxySocket.unshift(proxyHead)
      }
      socket.on('error', () => proxySocket.destroy())
      proxySocket.on('error', () => socket.destroy())
    })
    proxyReq.on('error', () => socket.destroy())
    proxyReq.end()
  }
}
