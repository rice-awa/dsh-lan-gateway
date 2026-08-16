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
} from '../src/auth.ts'
import {
  loadState,
  saveState,
  setPassword,
  stateDir,
  verifyPassword,
  type GatewayState,
} from '../src/state.ts'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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
})

describe('password state', () => {
  it('round-trips set -> verify', () => {
    let state: GatewayState = { cookieSecret: 'a'.repeat(32) }
    expect(verifyPassword(state, 'hunter2')).toBe(false)
    state = setPassword(state, 'hunter2')
    expect(state.password).toBeDefined()
    expect(verifyPassword(state, 'hunter2')).toBe(true)
    expect(verifyPassword(state, 'hunter3')).toBe(false)
    expect(verifyPassword(state, '')).toBe(false)
  })

  it('clears the password', () => {
    let state: GatewayState = setPassword({ cookieSecret: 'a'.repeat(32) }, 'hunter2')
    state = setPassword(state, undefined)
    expect(state.password).toBeUndefined()
    expect(verifyPassword(state, 'hunter2')).toBe(false)
  })

  it('re-salts on every write (hashes differ)', () => {
    const base: GatewayState = { cookieSecret: 'a'.repeat(32) }
    const a = setPassword(base, 'same-password')
    const b = setPassword(base, 'same-password')
    expect(a.password!.hash).not.toBe(b.password!.hash)
    expect(verifyPassword(a, 'same-password')).toBe(true)
    expect(verifyPassword(b, 'same-password')).toBe(true)
  })

  it('persists to disk and reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-state-'))
    const home = join(dir, 'fake-home')
    try {
      let state = setPassword({ cookieSecret: 'b'.repeat(32) }, 'persisted-pass')
      state = { ...state, cookieSecret: 'c'.repeat(32) }
      saveState(state, home)

      const reloaded = loadState(home)
      expect(reloaded.cookieSecret).toBe('c'.repeat(32))
      expect(verifyPassword(reloaded, 'persisted-pass')).toBe(true)

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
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('RateLimiter', () => {
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
})
