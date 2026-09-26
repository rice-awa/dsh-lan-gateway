/**
 * Unit tests for the plugin-level fail-closed guards that live in `index.ts`
 * but need no live sockets: `gatewayStartProblems` (which configs the listener
 * refuses to run under) and `isTrustedConfigRequest` (the loopback fence in
 * front of the native `/lan-gateway/config` route). Covers acceptance rows 5,
 * 10, 11 and 14 of the QVD-2026-57410 fix plan.
 *
 * @module tests/start-guard
 */

import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LAN_CIDR_STRINGS } from '../src/auth.ts'
import { gatewayStartProblems, isTrustedConfigRequest, resolveSecureCookies, validateConfig, type Config as GatewayConfig } from '../src/index.ts'

/** A fully-defaulted Config so a test only overrides what it is judging. */
function baseConfig(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    enabled: true,
    gatewayPort: 3081,
    lanCidrs: [...DEFAULT_LAN_CIDR_STRINGS],
    lanPasswordless: false,
    cookieMaxAgeDays: 7,
    cookieName: 'dsh_gw_auth',
    tlsEnabled: false,
    tlsMode: 'self-signed',
    tlsSelfSignedHosts: 'localhost',
    tlsCertMaxAgeDays: 825,
    allowInsecurePlaintext: false,
    ...over,
  }
}

/** A minimal stand-in for an incoming HTTP request. */
function fakeReq(headers: Record<string, string>, method = 'GET'): IncomingMessage {
  return { headers: { ...headers }, method } as unknown as IncomingMessage
}

describe('gatewayStartProblems (fail-closed start guard)', () => {
  it('row 14: refuses to run over plaintext without TLS, a trusted terminator, or the explicit opt-in', () => {
    const problems = gatewayStartProblems(baseConfig(), { upstreamSessionAvailable: false })
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join(' ')).toMatch(/plaintext/i)

    // Each acceptable encrypted ingress clears the objection.
    expect(gatewayStartProblems(baseConfig({ tlsEnabled: true }), { upstreamSessionAvailable: false }).join(' '))
      .not.toMatch(/plaintext/i)
    expect(gatewayStartProblems(baseConfig({ trustedTerminator: 'nginx' }), { upstreamSessionAvailable: false }).join(' '))
      .not.toMatch(/plaintext/i)
    expect(gatewayStartProblems(baseConfig({ allowInsecurePlaintext: true }), { upstreamSessionAvailable: false }).join(' '))
      .not.toMatch(/plaintext/i)
  })

  it('row 5: lanPasswordless is refused unless the base enforces browser-session auth', () => {
    const cfg = baseConfig({ lanPasswordless: true, tlsEnabled: true })
    const without = gatewayStartProblems(cfg, { upstreamSessionAvailable: false })
    expect(without.join(' ')).toMatch(/lanPasswordless/)

    const withAuth = gatewayStartProblems(cfg, { upstreamSessionAvailable: true })
    expect(withAuth.join(' ')).not.toMatch(/lanPasswordless/)
  })

  it('rejects a legacy authRequired=false loudly instead of silently ignoring it', () => {
    const problems = gatewayStartProblems(baseConfig({ authRequired: false, tlsEnabled: true }), { upstreamSessionAvailable: true })
    expect(problems.join(' ')).toMatch(/authRequired/)
  })

  it('a session-capable encrypted config with a password obligation is clean', () => {
    expect(gatewayStartProblems(baseConfig({ tlsEnabled: true }), { upstreamSessionAvailable: true }))
      .toEqual([])
  })

  it('reports every problem at once so the operator sees the full migration', () => {
    // authRequired legacy + plaintext + lanPasswordless-without-session, all
    // present at once.
    const problems = gatewayStartProblems(
      baseConfig({ authRequired: false, lanPasswordless: true }),
      { upstreamSessionAvailable: false },
    )
    expect(problems.length).toBeGreaterThanOrEqual(3)
  })
})

describe('isTrustedConfigRequest (loopback config-route fence)', () => {
  it('row 11: a same-origin loopback GET from the card passes', () => {
    expect(isTrustedConfigRequest(fakeReq({ host: '127.0.0.1:3080' }))).toBe(true)
    expect(isTrustedConfigRequest(fakeReq({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(isTrustedConfigRequest(fakeReq({ host: 'localhost:3080', origin: 'http://localhost:3080' }))).toBe(true)
  })

  it('row 10: a state-changing POST without an Origin is refused', () => {
    expect(isTrustedConfigRequest(fakeReq({ host: '127.0.0.1:3080' }, 'POST'))).toBe(false)
  })

  it('accepts a state-changing POST with a matching Origin', () => {
    expect(isTrustedConfigRequest(fakeReq({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, 'POST'))).toBe(true)
  })

  it('refuses a non-loopback Host (public IP / LAN address)', () => {
    expect(isTrustedConfigRequest(fakeReq({ host: '192.168.1.5:3081' }))).toBe(false)
    expect(isTrustedConfigRequest(fakeReq({ host: 'myhost.example:3081' }))).toBe(false)
    expect(isTrustedConfigRequest(fakeReq({ host: '8.8.8.8:3081' }))).toBe(false)
  })

  it('refuses a cross-site Origin even on a loopback Host', () => {
    expect(isTrustedConfigRequest(fakeReq({ host: '127.0.0.1:3080', origin: 'http://evil.example' }))).toBe(false)
  })

  it('refuses an explicit cross-site fetch', () => {
    expect(isTrustedConfigRequest(fakeReq({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }))).toBe(false)
  })

  it('refuses requests with no Host header at all', () => {
    expect(isTrustedConfigRequest(fakeReq({}))).toBe(false)
  })
})

describe('resolveSecureCookies (session-cookie Secure attribute)', () => {
  it('auto: plaintext without a terminator is not Secure', () => {
    expect(resolveSecureCookies(baseConfig({ allowInsecurePlaintext: true }))).toBe(false)
  })

  it('auto: a declared trusted terminator implies Secure', () => {
    expect(resolveSecureCookies(baseConfig({ trustedTerminator: 'nginx' }))).toBe(true)
  })

  it('auto: self TLS implies Secure', () => {
    expect(resolveSecureCookies(baseConfig({ tlsEnabled: true }))).toBe(true)
  })

  it('explicit false wins over a declared terminator (plaintext proxy front)', () => {
    expect(resolveSecureCookies(baseConfig({ trustedTerminator: 'nginx', secureCookies: false }))).toBe(false)
  })

  it('explicit true wins over a plaintext ingress', () => {
    expect(resolveSecureCookies(baseConfig({ allowInsecurePlaintext: true, secureCookies: true }))).toBe(true)
  })

  it('an explicit false survives schemastery round-trip rather than collapsing to auto', () => {
    // The settings card posts null to clear; a real false must not be coerced,
    // or the plaintext-proxy escape hatch would silently re-enable Secure.
    const parsed = validateConfig(baseConfig({ trustedTerminator: 'nginx', secureCookies: false }))
    expect(parsed.secureCookies).toBe(false)
    expect(resolveSecureCookies(parsed)).toBe(false)
  })

  it('a cleared (null) secureCookies falls back to automatic', () => {
    const parsed = validateConfig({ ...baseConfig({ trustedTerminator: 'nginx' }), secureCookies: null })
    expect(resolveSecureCookies(parsed)).toBe(true)
  })
})
