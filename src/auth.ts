/**
 * Authentication primitives for the LAN gateway: source-IP classification
 * (loopback / lan / internet), HMAC-signed session cookies, and an in-memory
 * per-source login rate limiter. Pure functions where possible so the tests
 * can exercise them without a live server. No runtime dependencies beyond
 * node:crypto.
 *
 * @module @riceawa/dsh-lan-gateway/auth
 */

import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto'

/** The three trust tiers a request source can fall into. */
export type SourceClass = 'loopback' | 'lan' | 'internet'

/** One CIDR range: an IPv4 address and its prefix length. */
export interface Cidr {
  addr: number
  prefix: number
}

const DEFAULT_LAN_CIDRS: readonly string[] = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16', // link-local
]

/** Default LAN CIDRs: RFC1918 + link-local, IPv4. */
export const DEFAULT_LAN_CIDR_STRINGS: readonly string[] = [...DEFAULT_LAN_CIDRS]

/** Parse a dotted-quad IPv4 string to its 32-bit integer, or undefined. */
export function parseIpv4(text: string): number | undefined {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const byte = Number(part)
    if (byte > 255) return undefined
    out = (out << 8) | byte
  }
  return out >>> 0
}

/** Parse `a.b.c.d/len` into a {@link Cidr}, or undefined on malformed input. */
export function parseCidr(text: string): Cidr | undefined {
  const slash = text.indexOf('/')
  const addrText = slash === -1 ? text : text.slice(0, slash)
  const prefixText = slash === -1 ? '32' : text.slice(slash + 1)
  const addr = parseIpv4(addrText)
  if (addr === undefined) return undefined
  if (!/^\d{1,2}$/.test(prefixText)) return undefined
  const prefix = Number(prefixText)
  if (prefix < 0 || prefix > 32) return undefined
  return { addr, prefix }
}

/** Whether a 32-bit IPv4 address falls inside one CIDR range. */
export function inCidr(ip: number, cidr: Cidr): boolean {
  if (cidr.prefix === 0) return true
  const mask = cidr.prefix === 32 ? 0xffffffff : (0xffffffff << (32 - cidr.prefix)) >>> 0
  return (ip & mask) === (cidr.addr & mask)
}

/** Normalize a raw socket address to a bare IPv4/6 string we classify on. */
function normalizeAddress(raw: string): string {
  const value = raw.trim()
  // IPv4-mapped IPv6: ::ffff:a.b.c.d
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)
  if (mapped !== null) return mapped[1]!
  return value
}

/**
 * Classify a source address string into one of the three trust tiers.
 * @param remoteAddress - the raw value of `req.socket.remoteAddress`.
 * @param lanCidrs - CIDR strings treated as trusted LAN space (IPv4).
 * @returns the classification. IPv4-mapped IPv6 addresses are unwrapped.
 */
export function classifySource(
  remoteAddress: string | undefined,
  lanCidrs: readonly string[] = DEFAULT_LAN_CIDR_STRINGS,
): SourceClass {
  const address = normalizeAddress(remoteAddress ?? '')
  if (address === '') return 'internet'

  // Loopback: IPv4 127/8, ::1, or mapped 127.x.
  const ipv4 = parseIpv4(address)
  if (ipv4 !== undefined) {
    if (ipv4 >>> 24 === 127) return 'loopback'
    for (const cidrText of lanCidrs) {
      const cidr = parseCidr(cidrText)
      if (cidr !== undefined && inCidr(ipv4, cidr)) return 'lan'
    }
    return 'internet'
  }

  if (address === '::1') return 'loopback'
  if (inIpv6LinkLocal(address)) return 'lan'
  return 'internet'
}

/**
 * Whether a textual IPv6 address falls inside fe80::/10. The first ten bits are
 * `1111111010`, so the leading hextet spans fe80–febf; a `startsWith('fe80:')`
 * test covers only fe80::/16 and misclassifies fe90::–febf:: as internet.
 */
function inIpv6LinkLocal(address: string): boolean {
  const match = /^([0-9a-fA-F]{1,4}):/.exec(address)
  if (match === null) return false
  return (Number.parseInt(match[1]!, 16) & 0xffc0) === 0xfe80
}

/** Encode a byte buffer as URL-safe base64 without padding. */
function base64url(input: Buffer): string {
  return input.toString('base64url')
}

/** The claims a verified session cookie carries. */
export interface SessionClaims {
  /** Epoch millis at which the session expires. */
  exp: number
  /** The revocation epoch the cookie was minted under. */
  epoch: number
  /**
   * Per-session id. Present on cookies minted from 0.5.4 on, which is what
   * lets one session be retired on its own (sign-out) instead of retiring
   * every session the password authorized. Absent on older cookies.
   */
  sid?: string
}

/**
 * Issue a signed session cookie value.
 * @param secret - the HMAC signing secret (base64 string).
 * @param expiresMs - epoch millis at which the session expires.
 * @param epoch - the session revocation epoch the cookie is minted under; a
 *   cookie whose epoch no longer matches the live state is rejected by
 *   {@link verifyCookie}. Defaults to 0 (epoch-less, legacy) for callers that
 *   do not participate in revocation.
 * @param sid - optional per-session id (see {@link SessionClaims.sid}).
 * @returns a `payload.signature` string suitable for the cookie value.
 */
export function signCookie(secret: string, expiresMs: number, epoch: number = 0, sid?: string): string {
  const claims = sid === undefined ? { exp: expiresMs, epoch } : { exp: expiresMs, epoch, sid }
  const payload = base64url(Buffer.from(JSON.stringify(claims)))
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/**
 * Verify a cookie's signature, expiry and epoch.
 * @returns the claims it carries, or undefined when it is not a valid session.
 */
export function verifySession(
  secret: string,
  value: string | undefined,
  now: number,
  epoch: number = 0,
): SessionClaims | undefined {
  if (value === undefined) return undefined
  const dot = value.indexOf('.')
  if (dot === -1) return undefined
  const payload = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest()
  let actual: Buffer
  try {
    actual = Buffer.from(sig, 'base64url')
  } catch {
    return undefined
  }
  if (expected.length !== actual.length) return undefined
  if (!timingSafeEqual(expected, actual)) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SessionClaims>
    if (typeof decoded.exp !== 'number' || decoded.exp <= now) return undefined
    const cookieEpoch = typeof decoded.epoch === 'number' ? decoded.epoch : 0
    if (cookieEpoch !== epoch) return undefined
    return {
      exp: decoded.exp,
      epoch: cookieEpoch,
      ...(typeof decoded.sid === 'string' ? { sid: decoded.sid } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * Whether a cookie value is a valid, unexpired session signed with `secret`
 * and minted under `epoch`. Epoch-less cookies (legacy payloads) count as
 * epoch 0, so an upgrade from a pre-0.5.0 state does not log everyone out.
 */
export function verifyCookie(
  secret: string,
  value: string | undefined,
  now: number,
  epoch: number = 0,
): boolean {
  return verifySession(secret, value, now, epoch) !== undefined
}

/**
 * Whether a browser Origin header names the same authority (hostname:port) as
 * a request Host header. Both sides run through WHATWG URL parsing so case and
 * an implicit scheme-default port never decide the match — the comparison the
 * gateway uses to tell same-origin browser requests from cross-site ones.
 * @param origin - the `Origin` header value, or undefined.
 * @param host - the `Host` header value, or undefined.
 * @returns true only when both parse and name the same host[:port].
 */
export function originMatchesHost(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

/** A token bucket limiter keyed by source address. */
export class RateLimiter {
  /**
   * Hard ceiling on tracked sources. Expiry alone only reclaims a bucket when
   * `prune` runs, and a spray from many distinct addresses inside one window
   * outruns it, so the map also sheds its soonest-expiring entries past this.
   */
  private static readonly MAX_BUCKETS = 10_000
  private readonly buckets = new Map<string, { tokens: number; resetAt: number }>()
  /** Epoch millis at which the next opportunistic sweep is due. */
  private nextPruneAt = 0
  constructor(
    private readonly maxTokens: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Attempt to consume one token for `key`.
   * @returns true when the attempt is allowed, false when the source is
   * temporarily rate-limited.
   */
  allow(key: string): boolean {
    const now = Date.now()
    // Sweep on a rolling window. Without this, expired buckets are only
    // replaced when their own key returns, so every address that ever posted
    // to the login route keeps an entry for the life of the process.
    if (now >= this.nextPruneAt) {
      this.prune(now)
      this.nextPruneAt = now + this.windowMs
    }
    const existing = this.buckets.get(key)
    if (existing !== undefined && existing.resetAt > now) {
      if (existing.tokens <= 0) return false
      existing.tokens -= 1
      return true
    }
    // A new bucket. A spray of distinct addresses inside one window outruns
    // expiry, so shed the closest-to-expiring entries first — they are the
    // ones about to lapse anyway, so the eviction costs the least fidelity.
    if (existing === undefined && this.buckets.size >= RateLimiter.MAX_BUCKETS) {
      this.evictSoonestToExpire()
    }
    this.buckets.set(key, { tokens: this.maxTokens - 1, resetAt: now + this.windowMs })
    return true
  }

  /** Drop expired buckets to bound memory. Called from {@link allow}. */
  prune(now: number = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }

  /** Trim back to 90% of the ceiling, oldest expiry first. */
  private evictSoonestToExpire(): void {
    const target = Math.floor(RateLimiter.MAX_BUCKETS * 0.9)
    const byExpiry = [...this.buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)
    for (const [key] of byExpiry.slice(0, Math.max(0, this.buckets.size - target))) {
      this.buckets.delete(key)
    }
  }
}
