/**
 * Self-signed certificate tests: DER generation round-trips through Node's
 * own X509Certificate parser, and the key actually signs a TLS handshake.
 */

import { describe, expect, it } from 'vitest'
import { X509Certificate } from 'node:crypto'
import { createServer, request } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import { generateSelfSignedCert, isIpv4Literal, parseIpv6Bytes } from '../src/x509.ts'

describe('generateSelfSignedCert', () => {
  it('produces a parseable v3 certificate with the requested SANs', () => {
    const { certPem, certDer, publicKey } = generateSelfSignedCert({
      hosts: ['localhost', '192.168.1.5', 'myhost.lan', 'fd00::1'],
      days: 30,
      commonName: 'lan-gateway',
    })
    const cert = new X509Certificate(certPem)
    expect(cert.subject).toContain('CN=lan-gateway')
    expect(cert.issuer).toContain('CN=lan-gateway') // self-signed
    expect(cert.subjectAltName).toContain('DNS:localhost')
    expect(cert.subjectAltName).toContain('DNS:myhost.lan')
    expect(cert.subjectAltName).toContain('IP Address:192.168.1.5')
    expect(cert.subjectAltName).toContain('IP Address:FD00:0:0:0:0:0:0:1')
    // The signature verifies against the embedded public key.
    expect(cert.verify(publicKey)).toBe(true)
    // Validity window covers ~30 days.
    const from = Date.parse(cert.validFrom)
    const to = Date.parse(cert.validTo)
    expect(to - from).toBeGreaterThan(29 * 86_400_000)
    expect(to - from).toBeLessThan(31 * 86_400_000)
    // DER output is exactly the PEM body.
    const body = certPem
      .replace('-----BEGIN CERTIFICATE-----\n', '')
      .replace('\n-----END CERTIFICATE-----\n', '')
      .replaceAll('\n', '')
    expect(Buffer.from(body, 'base64').equals(certDer)).toBe(true)
  })

  it('rejects an empty host list', () => {
    expect(() => generateSelfSignedCert({ hosts: [], days: 30 })).toThrow(/at least one host/)
  })

  it('encodes KeyUsage as digitalSignature + keyEncipherment (MSB-first bits)', () => {
    const { certDer } = generateSelfSignedCert({ hosts: ['localhost'], days: 1 })
    // keyUsage OID 2.5.29.15 = 06 03 55 1d 0f, followed by critical BOOLEAN
    // (01 01 ff) and an OCTET STRING wrapping BIT STRING 03 02 00 a0 —
    // 0 unused bits, bits 0 (digitalSignature) and 2 (keyEncipherment) set.
    const oid = Buffer.from('0603551d0f', 'hex')
    const idx = certDer.indexOf(oid)
    expect(idx).toBeGreaterThan(-1)
    const after = certDer.subarray(idx + oid.length, idx + oid.length + 12).toString('hex')
    expect(after).toContain('030200a0')
    // And it must NOT contain the reversed encoding (keyCertSign | encipherOnly).
    expect(after).not.toContain('03020005')
  })

  it('serves a TLS handshake with the generated certificate', async () => {
    const { certPem, keyPem } = generateSelfSignedCert({ hosts: ['localhost'], days: 1 })
    const server = createServer({ cert: certPem, key: keyPem }, (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200)
      res.end('tls-ok')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/', rejectUnauthorized: false }, (res: IncomingMessage) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        })
        req.on('error', reject)
        req.end()
      })
      expect(body).toBe('tls-ok')
    } finally {
      server.close()
    }
  })
})

describe('IP helpers', () => {
  it('detects IPv4 literals', () => {
    expect(isIpv4Literal('192.168.1.5')).toBe(true)
    expect(isIpv4Literal('999.1.1.1')).toBe(false)
    expect(isIpv4Literal('localhost')).toBe(false)
  })

  it('parses IPv6 literals to 16 bytes', () => {
    expect(parseIpv6Bytes('::1')).toEqual(Buffer.from('00000000000000000000000000000001', 'hex'))
    expect(parseIpv6Bytes('fd00::1')).toEqual(Buffer.from('fd000000000000000000000000000001', 'hex'))
    expect(parseIpv6Bytes('2001:db8::ff00:42:8329')).toEqual(
      Buffer.from('20010db8000000000000ff0000428329', 'hex'),
    )
    expect(parseIpv6Bytes('::ffff:192.168.0.1')).toEqual(
      Buffer.from('00000000000000000000ffffc0a80001', 'hex'),
    )
    expect(parseIpv6Bytes('not-an-ip')).toBeUndefined()
  })
})
