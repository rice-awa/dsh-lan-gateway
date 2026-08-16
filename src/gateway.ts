/**
 * The reverse-proxy gateway: a `node:http` server bound to `0.0.0.0` that
 * forwards every request to the loopback dsh web server, rewriting Host and
 * Origin so the dsh `/api` trust fence (which only trusts loopback) passes.
 *
 * Security model:
 * - Source is classified from `socket.remoteAddress` only (never
 *   `X-Forwarded-For`). LAN/loopback sources are proxied without a password;
 *   anything else must present a valid signed cookie or complete the login.
 * - Because this gateway rewrites Origin to loopback, dsh's own CSRF fence is
 *   blinded — so the gateway runs its own origin check on `/api*` requests
 *   BEFORE rewriting (reject `sec-fetch-site: cross-site` and any Origin that
 *   does not match the gateway authority the browser actually used).
 *
 * @module @dsh-external/dsh-lan-gateway/gateway
 */

import http from 'node:http'
import type { Duplex } from 'node:stream'
import {
  classifySource,
  RateLimiter,
  signCookie,
  verifyCookie,
  type SourceClass,
} from './auth.ts'
import {
  COOKIE_NAME,
  LOGIN_PATH,
  readBody,
  renderLoginPage,
  serveLoginGet,
  type LoginPageOptions,
} from './login.ts'
import { verifyPassword, type GatewayState } from './state.ts'

/** Configuration the gateway needs at listen time. */
export interface GatewayConfig {
  /** Port to bind on 0.0.0.0. */
  gatewayPort: number
  /** The loopback dsh web server port to forward to. */
  dshPort: number
  /** LAN CIDRs treated as password-free. */
  lanCidrs: readonly string[]
  /** Whether non-LAN sources require a password. */
  authRequired: boolean
  /** Cookie lifetime in days. */
  cookieMaxAgeDays: number
  /** Cookie name. */
  cookieName: string
}

const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024
const LOGIN_ATTEMPTS_LIMIT = 5
const LOGIN_ATTEMPTS_WINDOW_MS = 60_000

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

  constructor(private readonly config: GatewayConfig, state: GatewayState) {
    this.state = state
    this.server = http.createServer((req, res) => {
      void this.handleHttp(req, res)
    })
    this.server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head)
    })
  }

  /** Replace the in-memory state (e.g. after a password change). */
  setState(state: GatewayState): void {
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

  /** Close the server and stop accepting connections. */
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    return new Promise((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  private sourceClass(req: http.IncomingMessage): SourceClass {
    return classifySource(req.socket.remoteAddress, this.config.lanCidrs)
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

  /** Whether a request carries a valid session for its source. */
  private authorized(req: http.IncomingMessage): boolean {
    const cookie = this.sessionCookie(req)
    return cookie !== undefined && verifyCookie(this.state.cookieSecret, cookie, Date.now())
  }

  private serveUnauthorized(res: http.ServerResponse, limited: boolean): void {
    res.writeHead(302, {
      location: `${LOGIN_PATH}${limited ? '?limited=1' : ''}`,
    })
    res.end()
  }

  private serveLoginError(res: http.ServerResponse, message: string): void {
    const opts: LoginPageOptions = { error: message }
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(renderLoginPage(opts))
  }

  /** Handle one HTTP request: auth gate → CSRF fence → forward. */
  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const source = this.sourceClass(req)
    const url = req.url ?? '/'
    const pathname = url.split('?')[0] ?? '/'

    if (pathname === LOGIN_PATH) {
      this.handleLogin(req, res)
      return
    }

    if (source === 'internet' && this.config.authRequired) {
      if (!this.authorized(req)) {
        this.serveUnauthorized(res, false)
        return
      }
    }

    // CSRF fence for /api before any rewriting (see module docs).
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (!this.passesCsrfFence(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
    }

    this.forward(req, res, url)
  }

  /** Reject cross-site API traffic: the gateway's own origin check. */
  private passesCsrfFence(req: http.IncomingMessage): boolean {
    const headers = req.headers
    if (headers['sec-fetch-site'] === 'cross-site') return false
    const origin = headers.origin
    if (origin === undefined) return true
    try {
      const originHost = new URL(origin).host
      const requestHost = typeof headers.host === 'string' ? headers.host : ''
      // Compare with the gateway authority the browser actually used; a
      // browser always fills Host from the URL it loaded.
      return originHost === requestHost || originHost === stripDefaultPort(requestHost)
    } catch {
      return false
    }
  }

  /** Handle the login GET form / POST submission. */
  private handleLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
    const limited = req.url?.includes('limited=1') ?? false
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveLoginGet(res)
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
      return
    }

    const key = req.socket.remoteAddress ?? 'unknown'
    if (!this.loginLimiter.allow(key)) {
      this.serveLoginError(res, 'Too many attempts — please wait a minute.')
      return
    }

    void readBody(req, DEFAULT_BODY_LIMIT_BYTES, res).then((body) => {
      if (body === undefined) return // response already sent (413/400)
      let password: string | undefined
      try {
        const fields = new URLSearchParams(body)
        password = fields.get('password') ?? undefined
      } catch {
        password = undefined
      }
      if (password === undefined || !verifyPassword(this.state, password)) {
        this.serveLoginError(res, 'Incorrect password.')
        return
      }
      const expiresMs = Date.now() + this.config.cookieMaxAgeDays * 86_400_000
      const cookie = signCookie(this.state.cookieSecret, expiresMs)
      res.writeHead(302, {
        location: '/',
        'set-cookie': [
          `${this.config.cookieName}=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${this.config.cookieMaxAgeDays * 86_400}`,
        ],
      })
      res.end()
    })
  }

  /** Forward an HTTP request to dsh, rewriting Host/Origin to loopback. */
  private forward(req: http.IncomingMessage, res: http.ServerResponse, url: string): void {
    const headers: http.OutgoingHttpHeaders = { ...req.headers }
    headers.host = `127.0.0.1:${this.config.dshPort}`
    if (typeof headers.origin === 'string') {
      headers.origin = `http://127.0.0.1:${this.config.dshPort}`
    }
    // Hop-by-hop headers the gateway must not forward.
    delete headers['proxy-connection']
    delete headers.connection

    const proxyReq = http.request({
      host: '127.0.0.1',
      port: this.config.dshPort,
      method: req.method,
      path: url,
      headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
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

  /** Forward a WebSocket upgrade, splicing the raw duplex through to dsh. */
  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const source = this.sourceClass(req)
    if (source === 'internet' && this.config.authRequired && !this.authorized(req)) {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n',
      )
      socket.destroy()
      return
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers }
    headers.host = `127.0.0.1:${this.config.dshPort}`
    if (typeof headers.origin === 'string') {
      headers.origin = `http://127.0.0.1:${this.config.dshPort}`
    }
    // Unlike the plain-HTTP path, keep Connection: Upgrade / Upgrade: websocket
    // so dsh answers with 101 and node's client emits 'upgrade'.
    delete headers['proxy-connection']

    const proxyReq = http.request({
      host: '127.0.0.1',
      port: this.config.dshPort,
      method: 'GET',
      path: req.url ?? '/',
      headers,
    })
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
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

/** Strip an explicit default port from a Host authority, if present. */
function stripDefaultPort(host: string): string {
  const parsed = /^(.+?)(?::(\d+))?$/.exec(host)
  if (parsed?.[2] === '80' || parsed?.[2] === '443') return parsed[1]!
  return host
}
