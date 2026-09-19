/**
 * Unit tests for the LAN gateway auth primitives and persistent state:
 * source classification, signed cookies, scrypt password round-trips, and the
 * rate limiter. Pure functions — no live sockets needed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifySource,
  parseCidr,
  parseIpv4,
  RateLimiter,
  signCookie,
  verifyCookie,
  verifySession,
} from '../src/auth.ts'
import {
  isSessionRevoked,
  loadState,
  revokeSession,
  saveState,
  setPassword,
  stateDir,
  verifyPassword,
  type GatewayState,
} from '../src/state.ts'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(() => {
  vi.useRealTimers()
})

describe('parseIpv4', () => {
  it('parses a dotted quad', () => {
    expect(parseIpv4('192.168.1.18')).toBe(0xc0a80112)
    expect(parseIpv4('0.0.0.0')).toBe(0)
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffff)
  })

  it('rejects malformed input', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.4.5.6', 'a.b.c.d', '1.2.3.4 ', ' 1.2.3.4', '1e2.0.0.1']) {
      expect(parseIpv4(bad), bad).toBeUndefined()
    }
  })
})

describe('parseCidr', () => {
  it('parses a prefix', () => {
    expect(parseCidr('192.168.0.0/16')).toEqual({ addr: 0xc0a80000, prefix: 16 })
  })

  it('defaults to a /32 when no prefix is given', () => {
    expect(parseCidr('10.0.0.5')).toEqual({ addr: 0x0a000005, prefix: 32 })
  })

  it('rejects bad prefixes', () => {
    expect(parseCidr('10.0.0.0/33')).toBeUndefined()
    expect(parseCidr('10.0.0.0/-1')).toBeUndefined()
    expect(parseCidr('10.0.0.0/abc')).toBeUndefined()
    expect(parseCidr('nope/8')).toBeUndefined()
  })
})

describe('classifySource', () => {
  it('classifies loopback', () => {
    expect(classifySource('127.0.0.1')).toBe('loopback')
    expect(classifySource('127.5.5.5')).toBe('loopback')
    expect(classifySource('::1')).toBe('loopback')
    expect(classifySource('::ffff:127.0.0.1')).toBe('loopback')
    expect(classifySource('::ffff:127.1.2.3')).toBe('loopback')
  })

  it('classifies default LAN ranges (RFC1918 + link-local)', () => {
    expect(classifySource('192.168.1.18')).toBe('lan')
    expect(classifySource('10.0.0.1')).toBe('lan')
    expect(classifySource('172.16.0.1')).toBe('lan')
    expect(classifySource('172.31.255.254')).toBe('lan')
    expect(classifySource('169.254.1.1')).toBe('lan')
    expect(classifySource('fe80::1')).toBe('lan')
    expect(classifySource('::ffff:192.168.0.5')).toBe('lan')
  })

  it('classifies non-LAN (internet) sources', () => {
    expect(classifySource('8.8.8.8')).toBe('internet')
    expect(classifySource('100.70.197.22')).toBe('internet') // CGNAT / Tailscale
    expect(classifySource('100.64.0.1')).toBe('internet')
    expect(classifySource('192.0.2.1')).toBe('internet')
    expect(classifySource('2001:db8::1')).toBe('internet')
    expect(classifySource('2606:4700::1111')).toBe('internet')
  })

  it('honors custom LAN CIDRs', () => {
    expect(classifySource('100.70.197.22', ['100.64.0.0/10'])).toBe('lan')
    expect(classifySource('8.8.8.8', ['8.8.8.0/24'])).toBe('lan')
  })

  it('covers the whole of fe80::/10, not just fe80::/16', () => {
    // fe80::/10 is the first ten bits 1111111010 → leading hextet fe80–febf.
    expect(classifySource('fe80::1')).toBe('lan')
    expect(classifySource('fe90::1')).toBe('lan')
    expect(classifySource('febf::1')).toBe('lan')
    expect(classifySource('FE80::1')).toBe('lan')
    // Just outside the range on either side.
    expect(classifySource('fe7f::1')).toBe('internet')
    expect(classifySource('fec0::1')).toBe('internet') // site-local, deprecated
  })

  it('treats unknown as internet (never trusts)', () => {
    expect(classifySource(undefined)).toBe('internet')
    expect(classifySource('')).toBe('internet')
    expect(classifySource('garbage')).toBe('internet')
  })
})

describe('session cookies', () => {
  const secret = 'test-secret-1234567890'

  it('signs and verifies a valid cookie', () => {
    const cookie = signCookie(secret, 9999999999999)
    expect(verifyCookie(secret, cookie, Date.now())).toBe(true)
  })

  it('rejects an expired cookie', () => {
    const now = 1_000_000_000_000
    const cookie = signCookie(secret, now - 1)
    expect(verifyCookie(secret, cookie, now)).toBe(false)
  })

  it('rejects a tampered payload', () => {
    const cookie = signCookie(secret, 9999999999999)
    const [payload, sig] = cookie.split('.')
    const forged = `${payload!.replace(/\d/g, (d) => String((Number(d) + 1) % 10))}.${sig}`
    expect(forged).not.toBe(cookie)
    expect(verifyCookie(secret, forged, Date.now())).toBe(false)
  })

  it('rejects a cookie signed with a different secret', () => {
    const cookie = signCookie('other-secret-0000000000', 9999999999999)
    expect(verifyCookie(secret, cookie, Date.now())).toBe(false)
  })

  it('rejects malformed values', () => {
    expect(verifyCookie(secret, undefined, Date.now())).toBe(false)
    expect(verifyCookie(secret, '', Date.now())).toBe(false)
    expect(verifyCookie(secret, 'no-dot-here', Date.now())).toBe(false)
    expect(verifyCookie(secret, 'a.b!c', Date.now())).toBe(false)
    expect(verifyCookie(secret, '!!!!.!!!!', Date.now())).toBe(false)
  })

  it('rejects a non-numeric expiry claim', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 'soon' })).toString('base64url')
    const sig = payload // wrong signature also fine — tamper must fail anyway
    expect(verifyCookie(secret, `${payload}.${sig}`, Date.now())).toBe(false)
  })

  it('rejects a cookie signed under a different session epoch', () => {
    const cookie = signCookie(secret, 9999999999999, 1)
    expect(verifyCookie(secret, cookie, Date.now(), 0)).toBe(false)
    expect(verifyCookie(secret, cookie, Date.now(), 1)).toBe(true)
  })

  it('treats an epoch-less (pre-0.5.0) cookie as epoch 0', () => {
    const cookie = signCookie(secret, 9999999999999) // no epoch → 0
    expect(verifyCookie(secret, cookie, Date.now(), 0)).toBe(true)
    expect(verifyCookie(secret, cookie, Date.now(), 1)).toBe(false)
  })

  it('reports the claims a cookie carries, including its session id', () => {
    const cookie = signCookie(secret, 9999999999999, 2, 'session-a')
    expect(verifySession(secret, cookie, Date.now(), 2)).toEqual({
      exp: 9999999999999,
      epoch: 2,
      sid: 'session-a',
    })
  })

  it('reports no session id for a cookie minted without one', () => {
    // Cookies issued before per-session ids existed stay valid; they simply
    // cannot be revoked individually.
    const cookie = signCookie(secret, 9999999999999)
    expect(verifySession(secret, cookie, Date.now(), 0)?.sid).toBeUndefined()
  })

  it('verifySession refuses exactly what verifyCookie refuses', () => {
    const now = 1_000_000_000_000
    expect(verifySession(secret, undefined, now)).toBeUndefined()
    expect(verifySession(secret, '', now)).toBeUndefined()
    expect(verifySession(secret, 'no-dot-here', now)).toBeUndefined()
    expect(verifySession(secret, 'a.b!c', now)).toBeUndefined()
    expect(verifySession(secret, signCookie(secret, now - 1), now)).toBeUndefined()
    expect(verifySession('other-secret-0000000000', signCookie(secret, now + 1), now)).toBeUndefined()
    expect(verifySession(secret, signCookie(secret, now + 1, 1), now, 0)).toBeUndefined()
  })
})

describe('session revocation', () => {
  const base: GatewayState = { cookieSecret: 'a'.repeat(32), sessionEpoch: 0 }

  it('revokes one session id without touching another', () => {
    const next = revokeSession(base, 'session-a', Date.now() + 60_000)
    expect(isSessionRevoked(next, 'session-a')).toBe(true)
    expect(isSessionRevoked(next, 'session-b')).toBe(false)
    // A cookie that carries no id can only be retired wholesale (epoch bump).
    expect(isSessionRevoked(next, undefined)).toBe(false)
  })

  it('returns a new state rather than mutating the one it was given', () => {
    revokeSession(base, 'session-a', Date.now() + 60_000)
    expect(isSessionRevoked(base, 'session-a')).toBe(false)
    expect(base.revokedSessions).toBeUndefined()
  })

  it('drops entries whose own cookie has already expired', () => {
    const now = Date.now()
    const stale: GatewayState = {
      ...base,
      revokedSessions: { lapsed: now - 1, live: now + 60_000 },
    }
    const next = revokeSession(stale, 'session-a', now + 120_000)
    expect(Object.keys(next.revokedSessions!).sort()).toEqual(['live', 'session-a'])
  })

  it('persists the revocation list and reloads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-revoked-'))
    const home = join(dir, 'fake-home')
    try {
      const expiresAt = Date.now() + 60_000
      saveState({ ...base, revokedSessions: { 'session-a': expiresAt } }, home)
      expect(loadState(home).revokedSessions).toEqual({ 'session-a': expiresAt })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drops lapsed entries when loading, so the list stays bounded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-revoked-stale-'))
    const home = join(dir, 'fake-home')
    try {
      const live = Date.now() + 60_000
      saveState({ ...base, revokedSessions: { lapsed: Date.now() - 1, live } }, home)
      expect(loadState(home).revokedSessions).toEqual({ live })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a corrupt revocation list is ignored rather than fatal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-revoked-bad-'))
    const home = join(dir, 'fake-home')
    try {
      mkdirSync(stateDir(home), { recursive: true })
      writeFileSync(join(stateDir(home), 'state.json'), JSON.stringify({
        cookieSecret: 'a'.repeat(32),
        revokedSessions: { 'session-a': 'soon' },
      }))
      expect(loadState(home).revokedSessions).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a password change drops the list — the new epoch already covers it', () => {
    const state: GatewayState = {
      ...base,
      revokedSessions: { 'session-a': Date.now() + 60_000 },
    }
    expect(setPassword(state, 'hunter2').revokedSessions).toBeUndefined()
  })
})

describe('password state', () => {
  it('round-trips set -> verify', async () => {
    let state: GatewayState = { cookieSecret: 'a'.repeat(32), sessionEpoch: 0 }
    expect(await verifyPassword(state, 'hunter2')).toBe(false)
    state = setPassword(state, 'hunter2')
    expect(state.password).toBeDefined()
    expect(await verifyPassword(state, 'hunter2')).toBe(true)
    expect(await verifyPassword(state, 'hunter3')).toBe(false)
    expect(await verifyPassword(state, '')).toBe(false)
  })

  it('clears the password', async () => {
    let state: GatewayState = setPassword({ cookieSecret: 'a'.repeat(32), sessionEpoch: 0 }, 'hunter2')
    state = setPassword(state, undefined)
    expect(state.password).toBeUndefined()
    expect(await verifyPassword(state, 'hunter2')).toBe(false)
  })

  it('re-salts on every write (hashes differ)', async () => {
    const base: GatewayState = { cookieSecret: 'a'.repeat(32), sessionEpoch: 0 }
    const a = setPassword(base, 'same-password')
    const b = setPassword(base, 'same-password')
    expect(a.password!.hash).not.toBe(b.password!.hash)
    expect(await verifyPassword(a, 'same-password')).toBe(true)
    expect(await verifyPassword(b, 'same-password')).toBe(true)
  })

  it('persists to disk and reloads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-state-'))
    const home = join(dir, 'fake-home')
    try {
      let state = setPassword({ cookieSecret: 'b'.repeat(32), sessionEpoch: 0 }, 'persisted-pass')
      state = { ...state, cookieSecret: 'c'.repeat(32) }
      saveState(state, home)

      const reloaded = loadState(home)
      expect(reloaded.cookieSecret).toBe('c'.repeat(32))
      expect(await verifyPassword(reloaded, 'persisted-pass')).toBe(true)

      const files = readdirSync(stateDir(home))
      expect(files).toContain('state.json')
      expect(files.some((f) => f.includes('.tmp'))).toBe(false)
      expect(readFileSync(join(stateDir(home), 'state.json'), 'utf8')).not.toContain('persisted-pass')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('generates a fresh secret on first load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-first-'))
    const home = join(dir, 'fake-home')
    try {
      const state = loadState(home)
      expect(state.cookieSecret.length).toBeGreaterThanOrEqual(16)
      expect(state.password).toBeUndefined()
      expect(state.sessionEpoch).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('setting and clearing the password bump the session epoch', () => {
    let state = setPassword({ cookieSecret: 'a'.repeat(32), sessionEpoch: 0 }, 'hunter2')
    expect(state.sessionEpoch).toBe(1)
    const cleared = setPassword(state, undefined)
    expect(cleared.sessionEpoch).toBe(2)
    expect(cleared.password).toBeUndefined()
  })

  it('loads a pre-0.5.0 state file (no sessionEpoch) as epoch 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-migrate-'))
    const home = join(dir, 'fake-home')
    try {
      mkdirSync(stateDir(home), { recursive: true })
      writeFileSync(join(stateDir(home), 'state.json'), JSON.stringify({ cookieSecret: 'e'.repeat(32) }))
      const state = loadState(home)
      expect(state.cookieSecret).toBe('e'.repeat(32))
      expect(state.sessionEpoch).toBe(0)
      expect(state.password).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('RateLimiter', () => {
  /** The live bucket count. `buckets` is private but present at runtime. */
  function bucketCount(limiter: RateLimiter): number {
    return (limiter as unknown as { buckets: Map<string, unknown> }).buckets.size
  }

  it('allows up to the token budget then blocks', () => {
    const limiter = new RateLimiter(3, 60_000)
    expect(limiter.allow('1.1.1.1')).toBe(true)
    expect(limiter.allow('1.1.1.1')).toBe(true)
    expect(limiter.allow('1.1.1.1')).toBe(true)
    expect(limiter.allow('1.1.1.1')).toBe(false)
    expect(limiter.allow('1.1.1.1')).toBe(false)
    expect(limiter.allow('2.2.2.2')).toBe(true) // different source unaffected
  })

  it('refills after the window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const limiter = new RateLimiter(1, 100)
    expect(limiter.allow('1.1.1.1')).toBe(true)
    expect(limiter.allow('1.1.1.1')).toBe(false)
    vi.setSystemTime(1_700_000_000_000 + 101)
    expect(limiter.allow('1.1.1.1')).toBe(true)
  })

  it('sweeps expired buckets without waiting for their keys to return', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const limiter = new RateLimiter(1, 100)
    // A one-shot source that will never post again.
    expect(limiter.allow('9.9.9.9')).toBe(true)
    vi.setSystemTime(1_700_000_000_000 + 101)
    // A different source's attempt trips the sweep; the stale bucket is gone.
    expect(limiter.allow('8.8.8.8')).toBe(true)
    expect(bucketCount(limiter)).toBe(1)
  })

  it('keeps the bucket table under its ceiling', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    const limiter = new RateLimiter(1, 60_000)
    // All in one window, so expiry reclaims nothing: the ceiling must.
    for (let i = 0; i < 10_500; i += 1) limiter.allow(`10.0.${(i >> 8) & 0xff}.${i & 0xff}`)
    expect(bucketCount(limiter)).toBeLessThanOrEqual(10_000)
  })
})
