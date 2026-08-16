/**
 * Authentication primitives for the LAN gateway: source-IP classification
 * (loopback / lan / internet), HMAC-signed session cookies, and an in-memory
 * per-source login rate limiter. Pure functions where possible so the tests
 * can exercise them without a live server. No runtime dependencies beyond
 * node:crypto.
 *
 * @module @dsh-external/dsh-lan-gateway/auth
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
  // Link-local IPv6 fe80::/10.
  if (address.toLowerCase().startsWith('fe80:')) return 'lan'
  return 'internet'
}

/** Encode a byte buffer as URL-safe base64 without padding. */
function base64url(input: Buffer): string {
  return input.toString('base64url')
}

/**
 * Issue a signed session cookie value.
 * @param secret - the HMAC signing secret (base64 string).
 * @param expiresMs - epoch millis at which the session expires.
 * @returns a `payload.signature` string suitable for the cookie value.
 */
export function signCookie(secret: string, expiresMs: number): string {
  const payload = base64url(Buffer.from(JSON.stringify({ exp: expiresMs })))
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/** Whether a cookie value is a valid, unexpired session signed with `secret`. */
export function verifyCookie(secret: string, value: string | undefined, now: number): boolean {
  if (value === undefined) return false
  const dot = value.indexOf('.')
  if (dot === -1) return false
  const payload = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest()
  let actual: Buffer
  try {
    actual = Buffer.from(sig, 'base64url')
  } catch {
    return false
  }
  if (expected.length !== actual.length) return false
  if (!timingSafeEqual(expected, actual)) return false
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof decoded.exp === 'number' && decoded.exp > now
  } catch {
    return false
  }
}

/** A token bucket limiter keyed by source address. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; resetAt: number }>()
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
    const bucket = this.buckets.get(key)
    if (bucket === undefined || bucket.resetAt <= now) {
      this.buckets.set(key, { tokens: this.maxTokens - 1, resetAt: now + this.windowMs })
      return true
    }
    if (bucket.tokens > 0) {
      bucket.tokens -= 1
      return true
    }
    return false
  }

  /** Drop expired buckets to bound memory. */
  prune(now: number = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }
}
