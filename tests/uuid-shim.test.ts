/**
 * Insecure-origin UUID shim tests.
 *
 * The gateway serves the GUI over plain HTTP on LAN addresses, where browsers
 * do NOT expose `crypto.randomUUID` (secure-context-only Web API). These tests
 * exercise the shim against a crypto object that has only getRandomValues —
 * the exact insecure-origin shape — and assert the patched randomUUID is a
 * working RFC 4122 v4 generator.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installRandomUuidShim } from '../src/client/index.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('installRandomUuidShim', () => {
  it('installs a getRandomValues-backed randomUUID when the platform lacks it', () => {
    // Insecure origin: crypto exists with getRandomValues only, no randomUUID.
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        return bytes.fill(0)
      },
    })
    expect(typeof globalThis.crypto.randomUUID).toBe('undefined')
    expect(installRandomUuidShim()).toBe(true)
    expect(typeof globalThis.crypto.randomUUID).toBe('function')
    // Deterministic all-zero bytes → version/variant bits only.
    expect(globalThis.crypto.randomUUID()).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('is a no-op when randomUUID already exists (secure origin / Node)', () => {
    const real = globalThis.crypto.randomUUID
    expect(installRandomUuidShim()).toBe(false)
    expect(globalThis.crypto.randomUUID).toBe(real)
  })

  it('mints valid v4 UUIDs with distinct values', () => {
    let seed = 0
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        for (let i = 0; i < bytes.length; i++) bytes[i] = ((seed++) * 37 + 11) & 0xff
        return bytes
      },
    })
    installRandomUuidShim()
    const a = globalThis.crypto.randomUUID()
    const b = globalThis.crypto.randomUUID()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(b).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a).not.toBe(b)
  })
})
