/**
 * Every request decision the gateway makes, as pure functions over headers,
 * paths and config — the same treatment `auth.ts` already gives
 * `classifySource` / `signCookie` / `originMatchesHost`. `LanGateway` keeps the
 * `http.Server`, the socket bookkeeping and the relay; who may pass, which path
 * the gateway owns, and what the forwarded headers look like are decided here,
 * where a test can reach them with a literal object instead of a live socket.
 *
 * Nothing here reads a clock, a socket or a config file.
 *
 * @module @riceawa/dsh-lan-gateway/request-policy
 */

import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import { originMatchesHost, type SourceClass } from './auth.ts'
import { isUpstreamCookiePair, isUpstreamSessionCookie } from './upstream-session.ts'

/** The request facts a policy decision reads. */
export interface RequestHead {
  /**
   * Optional *and* explicitly undefined-able, matching how Node declares
   * `IncomingMessage.method`. Under `exactOptionalPropertyTypes` those are two
   * different types, and the shorter `method?: string` would reject a plain
   * `IncomingMessage` at every call site.
   */
  method?: string | undefined
  headers: IncomingHttpHeaders
}

/** Methods a browser never attaches a CSRF-meaningful body to; safe without an Origin. */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

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
 * Hop-by-hop headers a successful upgrade must still carry: 101 is exactly the
 * exchange that negotiates Connection/Upgrade, so they survive there and
 * nowhere else.
 */
const UPGRADE_HANDSHAKE_HEADERS = new Set(['connection', 'upgrade'])

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

/** Prefixes the gateway owns and must never relay to dsh. */
export function isOwnedPath(pathname: string): boolean {
  return pathname === '/lan-gateway' || pathname.startsWith('/lan-gateway/')
}

/**
 * The pathname a request is routed by: the one dsh's router resolves it to
 * (WHATWG URL parsing, which strips the query and collapses dot segments),
 * with trailing slashes then removed for the gateway's own surface tests.
 *
 * The decision paths below (owned prefix, login, logout) must use this rather
 * than the raw request target. dsh normalizes before matching, so a raw-string
 * test disagrees with it on `/foo/../lan-gateway/config` — that is not an owned
 * path by string prefix, stays in the relay, and lands on the plugin's own
 * config route once Host has been rewritten to loopback. Forwarding still
 * relays the raw target: dsh applies the same normalization itself.
 *
 * WHATWG parsing does not drop a trailing slash, and neither does dsh's
 * router, so `/__login/` is not the login page to either of them. The gateway
 * recognizes its own surfaces there anyway: `/__logout/` must still sign out,
 * and `/lan-gateway/config/` must be refused rather than relayed into dsh's
 * single-page fallback. Blocking a trailing-slash spelling of an owned prefix
 * errs toward refusing, which costs nothing — no upstream route lives under it.
 */
export function pathOf(url: string): string {
  try {
    return new URL(url, 'http://gateway.invalid').pathname.replace(/\/+$/, '') || '/'
  } catch {
    // Unparseable here means unparseable for dsh too; the raw target routes
    // nowhere and is relayed as-is.
    return url
  }
}

/**
 * Whether `hostname` is loopback (127/8, localhost, ::1).
 *
 * This validates a URL *hostname* — the loopback fence on the gateway's own
 * config route, where the input is the browser's Host header — so it accepts
 * the spellings a URL parser produces, `[::1]` included. `classifySource` in
 * `auth.ts` answers a different question about a different input (a socket
 * address, unwrapped from its `::ffff:` mapping, and including LAN space); the
 * two are related but not interchangeable, and neither should be rewritten in
 * terms of the other without moving its input domain too.
 */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** Whether this source must present a gateway session (default: everyone). */
export function requiresLogin(source: SourceClass, lanPasswordless: boolean): boolean {
  return !(lanPasswordless && source !== 'internet')
}

/** Parse the session cookie out of a Cookie header. */
export function sessionCookie(headers: IncomingHttpHeaders, cookieName: string): string | undefined {
  const header = headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${cookieName}=`)) {
      return trimmed.slice(cookieName.length + 1)
    }
  }
  return undefined
}

/**
 * The cross-site test shared by every gateway-owned entry point, applied before
 * any Host/Origin rewriting: an explicit cross-site fetch, or an Origin that
 * does not name the authority the browser actually used.
 *
 * Only claims a cross-site page cannot suppress are read, which is what makes
 * this usable on the login POST too (see {@link loginOriginAllowed}).
 */
export function isCrossSiteRequest(headers: IncomingHttpHeaders): boolean {
  if (headers['sec-fetch-site'] === 'cross-site') return true
  const origin = headers.origin
  if (origin !== undefined && !originMatchesHost(origin, headers.host)) return true
  return false
}

/**
 * The gateway's own cross-site gate, shared by HTTP and WebSocket upgrades and
 * applied before any Host/Origin rewriting. Browsers attach Origin to
 * state-changing requests and to every WebSocket handshake; reads without an
 * Origin (navigations, non-browser clients holding a session) stay allowed.
 */
export function sameSiteAllowed(req: RequestHead, upgrade: boolean): boolean {
  if (isCrossSiteRequest(req.headers)) return false
  const origin = req.headers.origin
  if (upgrade) return origin !== undefined
  if (!READ_ONLY_METHODS.has(req.method ?? 'GET')) return origin !== undefined
  return true
}

/**
 * The fence on the login POST. Issuing a session is as much a state change as
 * retiring one — and a cross-site form post burns the victim's source address
 * through the login rate limiter — so the login route runs the same cross-site
 * test as everything else.
 *
 * It deliberately stops short of {@link sameSiteAllowed}'s "a state-changing
 * request must carry an Origin" rule: a browser always sends an Origin on a
 * form POST, but curl, the dsh CLI and other non-browser clients legitimately
 * do not, and requiring one would lock them out of signing in. What remains is
 * what a cross-site page cannot forge or strip: `sec-fetch-site`, and an Origin
 * that disagrees with the Host the request names.
 */
export function loginOriginAllowed(headers: IncomingHttpHeaders): boolean {
  return !isCrossSiteRequest(headers)
}

/**
 * Drop every `dsh-auth-*` pair from a Cookie header, returning the remainder
 * (possibly '').
 *
 * The relay's session is appended to the client's own cookie, and upstream
 * reads the FIRST name match. A client that holds any `dsh-auth-<hash>` —
 * typically one minted before dsh's signing secret was reset, so still present
 * but no longer verifying — would therefore shadow the relay's session on every
 * request. That draws a 401, the gateway reads the 401 as "upstream revoked our
 * session" and discards it, the next request re-acquires, and the client's
 * stale cookie shadows that one too: a loop that never converges. Stripping the
 * namespace makes the relay's copy the only one.
 *
 * This filters the namespace; `isUpstreamSessionCookie` decides which cookie may
 * be *accepted* from upstream. The two are deliberately different rules.
 */
export function withoutUpstreamSessionPairs(cookie: string): string {
  return cookie
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '' && !isUpstreamCookiePair(pair))
    .join('; ')
}

/** How the outbound request headers are built. */
export interface UpstreamRequestOptions {
  /** The loopback dsh port the Host/Origin rewrite names. */
  dshPort: number
  /** Keep the WebSocket handshake's Connection/Upgrade headers. */
  keepUpgrade: boolean
  /** The shared upstream session to ride, when the relay holds one. */
  upstreamCookie?: string | undefined
}

/**
 * Build the outbound headers for one relayed request: rewrite Host/Origin to
 * the loopback upstream, drop hop-by-hop and caller-supplied forwarding
 * headers, clear the upstream cookie namespace the relay owns, and attach the
 * relayed session.
 */
export function upstreamRequestHeaders(
  headers: IncomingHttpHeaders,
  options: UpstreamRequestOptions,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = { ...headers }
  out.host = `127.0.0.1:${options.dshPort}`
  if (typeof out.origin === 'string') {
    out.origin = `http://127.0.0.1:${options.dshPort}`
  }
  delete out['proxy-connection']
  if (!options.keepUpgrade) {
    delete out.connection
    delete out.upgrade
  }
  for (const name of FORWARDING_HEADERS) delete out[name]
  if (typeof out.cookie === 'string') {
    const kept = withoutUpstreamSessionPairs(out.cookie)
    if (kept === '') delete out.cookie
    else out.cookie = kept
  }
  const relayed = options.upstreamCookie
  if (relayed !== undefined && relayed !== '') {
    const existing = out.cookie
    out.cookie = typeof existing === 'string' && existing !== ''
      ? `${existing}; ${relayed}`
      : relayed
  }
  return out
}

/**
 * Filter one direction's worth of headers through the same cookie rule, so the
 * HTTP and WebSocket branches cannot drift apart on it.
 */
function stripUpstreamCookies(entry: string): boolean {
  return !isUpstreamSessionCookie(entry.trim())
}

/**
 * The headers to send back to the client: hop-by-hop headers dropped, and the
 * upstream session cookie withheld. Upstream's one cookie-minting route is the
 * launch-token exchange at `/`, so a client that already holds a gateway session
 * could otherwise post the token through the gateway and walk away with a
 * durable upstream credential the relay exists to keep on this side. Cookies
 * from other routes (plugins) still pass through.
 */
export function downstreamResponseHeaders(upstream: IncomingHttpHeaders): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(upstream)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower === 'set-cookie') {
      const list = (Array.isArray(value) ? value : [value]).filter(stripUpstreamCookies)
      if (list.length > 0) headers[key] = list
      continue
    }
    headers[key] = value
  }
  return headers
}

/**
 * The headers of a 101 Switching Protocols response, replayed to the client on
 * the socket the gateway just spliced.
 *
 * {@link downstreamResponseHeaders} cannot be reused verbatim here: a successful
 * upgrade has to keep Connection/Upgrade, which are hop-by-hop on every other
 * response. The cookie rule is not relaxed with them — the relay's session is
 * withheld on this path too, so upstream cannot hand a client a durable
 * credential by attaching it to the handshake.
 */
export function upgradeResponseHeaders(upstream: IncomingHttpHeaders): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(upstream)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) && !UPGRADE_HANDSHAKE_HEADERS.has(lower)) continue
    if (lower === 'set-cookie') {
      const list = (Array.isArray(value) ? value : [value]).filter(stripUpstreamCookies)
      if (list.length > 0) headers[key] = list
      continue
    }
    headers[key] = value
  }
  return headers
}
