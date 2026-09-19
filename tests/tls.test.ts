/**
 * TLS material tests: self-signed persistence, custom cert loading, and host
 * parsing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isCertExpired,
  loadCustomCert,
  loadOrCreateSelfSigned,
  loadOrRenewSelfSigned,
  parseSelfSignedHosts,
  regenerateSelfSigned,
  tlsDir,
} from '../src/tls.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('self-signed material', () => {
  it('generates once and reuses the persisted files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-tls-'))
    const home = join(dir, 'fake-home')
    try {
      const first = loadOrCreateSelfSigned({ hosts: ['localhost', '10.0.0.4'], days: 30 }, home)
      expect(first.created).toBe(true)
      const second = loadOrCreateSelfSigned({ hosts: ['localhost', '10.0.0.4'], days: 30 }, home)
      expect(second.created).toBe(false)
      expect(second.material.cert).toBe(first.material.cert)
      expect(second.material.key).toBe(first.material.key)
      // Files live under the state dir with the cert/key pair.
      const certPath = join(tlsDir(home), 'selfsigned.crt')
      expect(readFileSync(certPath, 'utf8')).toBe(first.material.cert)
      expect(readFileSync(join(tlsDir(home), 'selfsigned.key'), 'utf8')).toBe(first.material.key)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('regenerate mints a fresh key pair', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-tls-regen-'))
    const home = join(dir, 'fake-home')
    try {
      const first = loadOrCreateSelfSigned({ hosts: ['localhost'], days: 30 }, home)
      const next = regenerateSelfSigned({ hosts: ['localhost'], days: 30 }, home)
      expect(next.cert).not.toBe(first.material.cert)
      expect(next.key).not.toBe(first.material.key)
      const reloaded = loadOrCreateSelfSigned({ hosts: ['localhost'], days: 30 }, home)
      expect(reloaded.material.cert).toBe(next.cert)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an empty host list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-tls-empty-'))
    const home = join(dir, 'fake-home')
    try {
      expect(() => loadOrCreateSelfSigned({ hosts: [], days: 30 }, home)).toThrow(/at least one host/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports whether a certificate has lapsed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-tls-expiry-'))
    const home = join(dir, 'fake-home')
    try {
      const { material } = loadOrCreateSelfSigned({ hosts: ['localhost'], days: 30 }, home)
      expect(isCertExpired(material.cert)).toBe(false)
      // Asked from a day past notAfter, the same certificate reads as expired.
      expect(isCertExpired(material.cert, Date.now() + 31 * 86_400_000)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reuses a live certificate but replaces a lapsed one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-tls-renew-'))
    const home = join(dir, 'fake-home')
    const opts = { hosts: ['localhost'], days: 30 }
    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const first = loadOrRenewSelfSigned(opts, home)
      expect(first.renewed).toBe(false)

      // Halfway through the validity window the persisted pair is reused.
      vi.setSystemTime(new Date('2026-01-15T00:00:00Z'))
      const reused = loadOrRenewSelfSigned(opts, home)
      expect(reused.renewed).toBe(false)
      expect(reused.material.cert).toBe(first.material.cert)

      // Past notAfter a fresh pair is minted and written to disk: a lapsed
      // certificate is one browsers refuse outright, so it is not served.
      vi.setSystemTime(new Date('2026-03-15T00:00:00Z'))
      const renewed = loadOrRenewSelfSigned(opts, home)
      expect(renewed.renewed).toBe(true)
      expect(renewed.material.cert).not.toBe(first.material.cert)
      expect(readFileSync(join(tlsDir(home), 'selfsigned.crt'), 'utf8')).toBe(renewed.material.cert)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('loadCustomCert', () => {
  it('requires both paths', () => {
    expect(() => loadCustomCert('', '')).toThrow(/tlsCertPath/)
    expect(() => loadCustomCert('/tmp/x.pem', '')).toThrow(/tlsKeyPath/)
  })

  it('fails clearly on a missing file', () => {
    expect(() => loadCustomCert('/nonexistent/cert.pem', '/nonexistent/key.pem')).toThrow(/cannot read TLS certificate/)
  })

  it('loads a real PEM pair and rejects a non-certificate file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-tls-custom-'))
    try {
      const { material } = loadOrCreateSelfSigned({ hosts: ['localhost'], days: 30 }, dir)
      const certPath = join(dir, 'c.pem')
      const keyPath = join(dir, 'k.pem')
      // Reuse the generated material as the "user-supplied" pair.
      writeFileSync(certPath, material.cert)
      writeFileSync(keyPath, material.key)
      const loaded = loadCustomCert(certPath, keyPath)
      expect(loaded.cert).toBe(material.cert)
      expect(loaded.key).toBe(material.key)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('parseSelfSignedHosts', () => {
  it('splits on commas/semicolons and trims', () => {
    expect(parseSelfSignedHosts('localhost, 10.0.0.4 ; my.host ')).toEqual([
      'localhost', '10.0.0.4', 'my.host',
    ])
    expect(parseSelfSignedHosts(undefined)).toEqual([])
    expect(parseSelfSignedHosts('   ')).toEqual([])
  })
})
