/**
 * The reverse-proxy gateway: a `node:http(s)` server bound to the unspecified
 * address (dual-stack, so IPv6 clients reach it too) that forwards every
 * request to the loopback dsh web server.
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
 *   request (HTTP and WebSocket upgrade) BEFORE rewriting. See
 *   `request-policy.ts`, which owns that decision along with every other
 *   header/path/server decision; this module owns the transport.
 * - Against a session-capable dsh base the Host/Origin rewrite alone would
 *   still earn a 401 (dsh no longer trusts a loopback Host; it demands its own
 *   authority-bound session cookie). The gateway therefore relays one shared
 *   upstream session acquired through the launch-token exchange and replays it
 *   on every forwarded request. See `upstream-session.ts`.
 * - Sessions are revocable two ways. Each carries a random id, so signing out
 *   retires exactly that session and the WebSockets it opened; and each
 *   carries a revocation epoch, so a password change or secret rotation kills
 *   every session at once — cookie, socket, and all.
 *
 * @module @riceawa/dsh-lan-gateway/gateway
 */

import http from 'node:http'
import https from 'node:https'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import {
  classifySource,
  RateLimiter,
  signCookie,
  verifySession,
  type SessionClaims,
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
import {
  downstreamResponseHeaders,
  isOwnedPath,
  loginOriginAllowed,
  pathOf,
  requiresLogin,
  sameSiteAllowed,
  sessionCookie,
  upgradeResponseHeaders,
  upstreamRequestHeaders,
} from './request-policy.ts'
import {
  isSessionRevoked,
  revokeSession,
  verifyPassword,
  type GatewayState,
} from './state.ts'
import type { UpstreamSession } from './upstream-session.ts'

/** Configuration the gateway needs at listen time. */
export interface GatewayConfig {
  /** Port to bind on the unspecified address (dual-stack; see {@link LanGateway.listen}). */
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
  /**
   * Called after the gateway revokes a session itself (sign-out), so the plugin
   * can persist a state the gateway changed on its own. The gateway has already
   * installed it locally by then.
   */
  onStateChange?: (state: GatewayState) => void
}

const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024
const LOGIN_ATTEMPTS_LIMIT = 5
const LOGIN_ATTEMPTS_WINDOW_MS = 60_000

/**
 * How long a half-open upstream WebSocket handshake may hang before the
 * gateway gives up on it. Without a deadline the client socket sits in the
 * pending table forever and never learns the upgrade failed — node's http
 * client would wait out its own socket timeout, which is measured in minutes.
 */
const UPGRADE_HANDSHAKE_TIMEOUT_MS = 15_000

/** A pending or established WebSocket, and the gate generation it was admitted under. */
interface TrackedSocket {
  /** The session that opened it; undefined for a cookie predating per-session ids. */
  sid: string | undefined
  /** The gate generation at admission; a bump retires every socket below it. */
  gate: number
}

/** A fresh per-session id: 128 random bits, URL-safe. */
function newSessionId(): string {
  return randomBytes(16).toString('base64url')
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
  /**
   * Every WebSocket this gateway is responsible for, keyed by the client
   * socket: pending handshakes as well as established ones.
   *
   * A socket outlives the request that authenticated it, so it has to be
   * closable by session: on an epoch bump every socket dies, and on sign-out
   * only that session's. A handshake that is still waiting on the relay or on
   * upstream's 101 is tracked from the moment it passes the gates, not from the
   * moment it is spliced — otherwise a revocation that lands mid-handshake
   * closes the map's contents and then watches the abandoned handshake finish
   * and register itself as live.
   */
  private readonly sockets = new Map<Duplex, TrackedSocket>()
  /**
   * Bumped by every revocation (epoch change, per-session sign-out) and by
   * disposal. A socket is retired when the generation moves past the one it was
   * admitted under, which is what lets a pending handshake be judged by the
   * rules in force when it *completes* rather than when it started.
   */
  private gate = 0

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
      // An epoch bump retires every session, so every socket goes — including a
      // handshake still waiting upstream, which the gate bump leaves unable to
      // re-admit itself when its 101 arrives.
      this.gate += 1
      this.destroyAllSockets()
    }
    this.state = state
  }

  /**
   * Start listening on the configured port. The listener is dual-stack: with
   * no host given, node binds the unspecified IPv6 address `::` — which also
   * accepts IPv4 clients, arriving as `::ffff:a.b.c.d` for the classifier to
   * unwrap — when the host has IPv6, and falls back to `0.0.0.0` when it does
   * not. Binding IPv4 only used to leave every IPv6 client (including `::1`)
   * unable to reach a gateway that classifies them.
   */
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
      this.server.listen(this.config.gatewayPort)
    })
  }

  /** The address actually bound, for logs and status (never a claim about it). */
  boundAddress(): string {
    const address = this.server.address()
    if (address === null || typeof address === 'string') return `port ${this.config.gatewayPort}`
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
    return `${host}:${address.port}`
  }

  /** Close the server, drop every socket, and stop accepting connections. */
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.gate += 1
    this.destroyAllSockets()
    return new Promise((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  private destroyAllSockets(): void {
    for (const socket of this.sockets.keys()) {
      socket.destroy()
    }
    this.sockets.clear()
  }

  /** Close the sockets one session opened, so signing out ends its live streams too. */
  private destroySocketsFor(sid: string): void {
    for (const [socket, tracked] of this.sockets) {
      if (tracked.sid !== sid) continue
      this.sockets.delete(socket)
      socket.destroy()
    }
  }

  /** Track a socket from admission to close. */
  private trackSocket(socket: Duplex, sid: string | undefined): void {
    this.sockets.set(socket, { sid, gate: this.gate })
    socket.on('close', () => {
      this.sockets.delete(socket)
    })
  }

  /** Whether a socket is still tracked, undisposed, and admitted under the current gate. */
  private stillAdmitted(socket: Duplex): boolean {
    if (this.disposed) return false
    const tracked = this.sockets.get(socket)
    return tracked !== undefined && tracked.gate === this.gate
  }

  private sourceOf(req: http.IncomingMessage): SourceClass {
    return this.config.classifySource !== undefined
      ? this.config.classifySource(req)
      : classifySource(req.socket.remoteAddress, this.config.lanCidrs)
  }

  /**
   * The session a request carries, or undefined when it presents none, presents
   * one that no longer verifies under the current epoch, or presents one whose
   * id has been signed out.
   */
  private session(req: http.IncomingMessage): SessionClaims | undefined {
    const cookie = sessionCookie(req.headers, this.config.cookieName)
    if (cookie === undefined) return undefined
    const claims = verifySession(
      this.state.cookieSecret,
      cookie,
      Date.now(),
      this.state.sessionEpoch,
    )
    if (claims === undefined) return undefined
    return isSessionRevoked(this.state, claims.sid) ? undefined : claims
  }

  /** Whether a request carries a session valid under the current epoch. */
  private authorized(req: http.IncomingMessage): boolean {
    return this.session(req) !== undefined
  }

  /**
   * Send an unauthorized caller to the login form. The rate limiter's refusal
   * does not come through here: it is answered on the POST itself, where the
   * banner can be rendered without a round trip.
   */
  private serveUnauthorized(res: http.ServerResponse): void {
    res.writeHead(302, {
      location: LOGIN_PATH,
      ...this.securityHeaders(),
    })
    res.end()
  }

  private serveLoginError(res: http.ServerResponse, message: string, limited = false): void {
    const opts: LoginPageOptions = limited ? { limited: true } : { error: message }
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

  private sessionSetCookie(value: string, maxAgeSeconds: number): string {
    const attributes = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`
    return `${this.config.cookieName}=${value}; ${attributes}${this.config.secureCookies ? '; Secure' : ''}`
  }

  /** Handle one HTTP request: login surface → owned-path refuse → session gate → same-site gate → relay. */
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

    if (requiresLogin(source, this.config.lanPasswordless) && !this.authorized(req)) {
      this.serveUnauthorized(res)
      return
    }

    if (!sameSiteAllowed(req, false)) {
      res.writeHead(403, this.securityHeaders())
      res.end('forbidden')
      return
    }

    await this.relayHttp(req, res, url)
  }

  /** Handle the login GET form / POST submission. */
  private handleLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveLoginGet(res, this.securityHeaders())
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' })
      res.end()
      return
    }

    // Issuing a session is a state change on the same footing as retiring one
    // (see handleLogout), and a cross-site form post spends the victim's source
    // address in the login limiter. Refuse before the limiter so a hostile page
    // cannot drain someone else's budget either.
    if (!loginOriginAllowed(req.headers)) {
      res.writeHead(403, this.securityHeaders())
      res.end('forbidden')
      return
    }

    const key = req.socket.remoteAddress ?? 'unknown'
    if (!this.loginLimiter.allow(key)) {
      this.serveLoginError(res, 'Too many attempts — please wait a minute.', true)
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
      // Verify against the state this request started under, and refuse to sign
      // anything if it moved. scrypt takes tens of milliseconds; a password
      // change, a clear, or a secret rotation landing inside that window
      // advances the epoch, and signing the new epoch on the strength of the
      // old password would hand back exactly the session the epoch bump was
      // meant to kill.
      const checked = this.state
      const accepted = password !== undefined && await verifyPassword(checked, password)
      if (this.state !== checked || this.disposed) {
        this.serveLoginError(res, 'Sign-in was interrupted — please try again.')
        return
      }
      if (!accepted) {
        this.serveLoginError(res, 'Incorrect password.')
        return
      }
      const maxAgeSeconds = this.config.cookieMaxAgeDays * 86_400
      const expiresMs = Date.now() + maxAgeSeconds * 1000
      // Every session gets its own id so signing out can retire this one alone.
      const cookie = signCookie(
        this.state.cookieSecret,
        expiresMs,
        this.state.sessionEpoch,
        newSessionId(),
      )
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

  /**
   * POST /__logout: revoke this session and clear the cookie.
   *
   * The session is stateless, so clearing the cookie only stops the browser
   * that ran the sign-out; a copy of the same value held anywhere else would
   * keep working until it expired. Revoking the id in the cookie retires that
   * one session for good, and leaves the account's other sessions — other
   * devices, other browsers — alone. Bumping the session epoch here would be
   * the blunter instrument: it signs out every session there is.
   */
  private handleLogout(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    // A logout is a state change: refuse cross-site triggers.
    if (!sameSiteAllowed(req, false)) {
      res.writeHead(403, this.securityHeaders())
      res.end('forbidden')
      return
    }
    const claims = this.session(req)
    if (claims?.sid !== undefined) {
      this.state = revokeSession(this.state, claims.sid, claims.exp)
      this.config.onStateChange?.(this.state)
      // Dropping the session's sockets from the map is what retires a handshake
      // it opened mid-flight too: the 101 callback re-checks membership, finds
      // it gone, and closes instead of splicing. The epoch is untouched, so the
      // account's other sessions keep working.
      this.destroySocketsFor(claims.sid)
    }
    res.writeHead(302, {
      location: '/',
      ...this.securityHeaders(),
      'set-cookie': [this.sessionSetCookie('', 0)],
    })
    res.end()
  }

  /** The shared upstream session's cookie value, if the relay holds one. */
  private async upstreamCookie(): Promise<string | undefined> {
    return this.config.upstreamSession === undefined
      ? undefined
      : this.config.upstreamSession.cookie()
  }

  /** Forward an HTTP request to dsh, replaying the shared upstream session. */
  private async relayHttp(req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<void> {
    const session = this.config.upstreamSession
    const relayed = await this.upstreamCookie()
    const headers = upstreamRequestHeaders(req.headers, {
      dshPort: this.config.dshPort,
      keepUpgrade: false,
      upstreamCookie: relayed,
    })
    const attached = relayed !== undefined

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
      res.writeHead(proxyRes.statusCode ?? 502, downstreamResponseHeaders(proxyRes.headers))
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

    // The session is read once: the socket this upgrade ends up holding stays
    // attributable to it, so signing that session out can close the socket.
    const claims = this.session(req)
    if (requiresLogin(source, this.config.lanPasswordless) && claims === undefined) {
      refuse(401)
      return
    }

    // Upgrades are state changes that only browsers meaningfully make: require
    // a same-origin Origin so a cross-site page cannot open a socket that rides
    // the requester's ambient session.
    if (!sameSiteAllowed(req, true)) {
      refuse(403)
      return
    }

    // Own the socket from here, not from the 101: everything below awaits, and
    // an epoch bump, a sign-out or a dispose landing in that window has to be
    // able to reach this handshake.
    this.trackSocket(socket, claims?.sid)
    const retire = (): void => {
      if (!this.sockets.delete(socket)) return
      socket.destroy()
    }

    const relayed = await this.upstreamCookie()
    if (!this.stillAdmitted(socket)) {
      retire()
      return
    }
    const headers = upstreamRequestHeaders(req.headers, {
      dshPort: this.config.dshPort,
      keepUpgrade: true,
      upstreamCookie: relayed,
    })

    const proxyReq = http.request({
      host: '127.0.0.1',
      port: this.config.dshPort,
      method: 'GET',
      path: url,
      headers,
    })
    const timer = setTimeout(() => {
      // Nothing came back in time. Drop both ends rather than leave the client
      // socket parked in the map with no way to learn the handshake failed.
      proxyReq.destroy()
      retire()
    }, UPGRADE_HANDSHAKE_TIMEOUT_MS)
    const settle = (): void => {
      clearTimeout(timer)
    }

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      settle()
      // The gated decision was made before the relay exchange and before
      // upstream answered; re-check it now, because a revocation in between is
      // exactly the case that used to slip through and register a live socket
      // after the sweep had already run.
      if (!this.stillAdmitted(socket)) {
        proxySocket.destroy()
        retire()
        return
      }
      // node's http client has already consumed the 101 response headers, so
      // reconstruct them on the client socket before splicing.
      const status = proxyRes.statusCode ?? 101
      const statusLine = `HTTP/1.1 ${status} ${proxyRes.statusMessage ?? 'Switching Protocols'}\r\n`
      const headerLines = Object.entries(upgradeResponseHeaders(proxyRes.headers))
        .flatMap(([key, value]) => (Array.isArray(value) ? value : [value])
          .map(entry => `${key}: ${entry}\r\n`))
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

    // A non-101 response is an ordinary HTTP answer to the handshake: upstream
    // refused it (401 after a revocation, 404 for an unknown path, 502 from a
    // proxy). Without this branch node emits neither 'upgrade' nor 'error' and
    // the client socket would sit open forever holding no connection at all.
    proxyReq.on('response', (proxyRes) => {
      settle()
      proxyRes.resume() // drain so the socket can be released
      if (!this.stillAdmitted(socket)) {
        retire()
        return
      }
      if (proxyRes.statusCode === 401 && relayed !== undefined) {
        // Same reading as the HTTP branch: upstream rejected the session we
        // relayed, so drop it. Otherwise a base that only ever sees WebSocket
        // reconnects would keep replaying a dead session until it lapses.
        this.config.upstreamSession?.invalidate()
      }
      const body = `upstream refused the WebSocket upgrade (HTTP ${proxyRes.statusCode ?? 502})`
      socket.write(
        `HTTP/1.1 ${proxyRes.statusCode ?? 502} ${proxyRes.statusMessage ?? 'Upstream Refused'}\r\n`
        + `Connection: close\r\nContent-Type: text/plain; charset=utf-8\r\n`
        + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      )
      retire()
    })

    proxyReq.on('error', () => {
      settle()
      retire()
    })
    proxyReq.end()
  }
}
