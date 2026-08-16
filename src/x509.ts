/**
 * Minimal X.509 v3 self-signed certificate generator built on `node:crypto`
 * only — no openssl binary, no npm dependencies.
 *
 * The certificate is a standard RSA-2048 / sha256WithRSAEncryption leaf cert
 * (CA:FALSE) carrying the requested DNS/IP SANs, so browsers accept it for
 * `https://<host>:<port>` after the user approves the self-signed warning.
 *
 * @module @dsh-external/dsh-lan-gateway/x509
 */

import {
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'

/* ------------------------------------------------------------------ */
/* ASN.1 DER primitives                                                */
/* ------------------------------------------------------------------ */

const TAG_SEQUENCE = 0x30
const TAG_SET = 0x31
const TAG_INTEGER = 0x02
const TAG_OID = 0x06
const TAG_BIT_STRING = 0x03
const TAG_OCTET_STRING = 0x04
const TAG_UTF8_STRING = 0x0c
const TAG_UTCTIME = 0x17
const TAG_NULL = 0x05
/** Context-specific primitive [2] (dNSName / iPAddress inside SAN). */
const TAG_CONTEXT_2 = 0x82
/** Context-specific primitive [7] (iPAddress). */
const TAG_CONTEXT_7 = 0x87

/** DER length octets (short form up to 127, long form above). */
function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let n = length
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

/** Tag a body with an identifier octet. */
function derTag(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

/** SEQUENCE OF parts. */
function derSeq(...parts: Buffer[]): Buffer {
  return derTag(TAG_SEQUENCE, Buffer.concat(parts))
}

/** SET OF parts (one RDN). */
function derSet(...parts: Buffer[]): Buffer {
  return derTag(TAG_SET, Buffer.concat(parts))
}

/** INTEGER from raw big-endian bytes (strips leading zeros, keeps sign bit clean). */
function derInt(value: Buffer): Buffer {
  let start = 0
  while (start < value.length - 1 && value[start] === 0) start += 1
  let body = value.subarray(start)
  if ((body[0]! & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body])
  return derTag(TAG_INTEGER, body)
}

/** OBJECT IDENTIFIER from a dotted string like `1.2.840.113549.1.1.11`. */
function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number)
  if (parts.length < 2 || parts.some(p => !Number.isInteger(p) || p < 0)) {
    throw new Error(`invalid OID: ${oid}`)
  }
  const body: number[] = [parts[0]! * 40 + parts[1]!]
  for (const part of parts.slice(2)) {
    let n = part
    const chunk: number[] = [n & 0x7f]
    n >>>= 7
    while (n > 0) {
      chunk.unshift((n & 0x7f) | 0x80)
      n >>>= 7
    }
    body.push(...chunk)
  }
  return derTag(TAG_OID, Buffer.from(body))
}

/** BIT STRING over raw content (unused-bits octet prepended). */
function derBitString(content: Buffer, unusedBits = 0): Buffer {
  return derTag(TAG_BIT_STRING, Buffer.concat([Buffer.from([unusedBits]), content]))
}

/** OCTET STRING. */
function derOctetString(content: Buffer): Buffer {
  return derTag(TAG_OCTET_STRING, content)
}

/** UTF8String (legal DirectoryString for the CN). */
function derUtf8String(text: string): Buffer {
  return derTag(TAG_UTF8_STRING, Buffer.from(text, 'utf8'))
}

/** UTCTime: `YYMMDDHHMMSSZ` (valid until 2050). */
function derUtcTime(date: Date): Buffer {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}`
    + `${pad(date.getUTCDate())}${pad(date.getUTCHours())}`
    + `${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  return derTag(TAG_UTCTIME, Buffer.from(text, 'ascii'))
}

/** BOOLEAN. */
function derBoolean(value: boolean): Buffer {
  return derTag(0x01, Buffer.from([value ? 0xff : 0x00]))
}

/** SHA-256 with RSA encryption (no parameters). */
function sha256WithRsa(): Buffer {
  return derSeq(derOid('1.2.840.113549.1.1.11'))
}

/** RSA encryption with NULL parameters (the SPKI algorithm id). */
function rsaEncryption(): Buffer {
  return derSeq(derOid('1.2.840.113549.1.1.1'), derTag(TAG_NULL, Buffer.alloc(0)))
}

/* ------------------------------------------------------------------ */
/* IPv6 parsing for IP SANs                                            */
/* ------------------------------------------------------------------ */

/**
 * Parse an IPv6 literal into its 16 raw bytes. Supports `::` compression,
 * hex groups, and an embedded dotted-quad IPv4 tail.
 */
export function parseIpv6Bytes(text: string): Buffer | undefined {
  let address = text.trim()
  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1)
  }
  if (address.includes('/')) address = address.split('/')[0]!
  const embeddedIpv4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  let head = address
  let tail: number[] = []
  if (embeddedIpv4 !== null) {
    head = embeddedIpv4[1]!.replace(/:$/, '')
    tail = embeddedIpv4[2]!.split('.').map(Number)
    if (tail.some(b => !Number.isInteger(b) || b < 0 || b > 255)) return undefined
  }
  const doubleColon = head.indexOf('::')
  if (doubleColon !== -1) {
    if (head.indexOf('::', doubleColon + 1) !== -1) return undefined
    const left = head.slice(0, doubleColon)
    const right = head.slice(doubleColon + 2)
    const leftWords = parseWords(left)
    const rightWords = parseWords(right)
    if (leftWords === undefined || rightWords === undefined) return undefined
    if (leftWords.length + rightWords.length + tail.length / 2 > 8) return undefined
    const gap = 8 - leftWords.length - rightWords.length - tail.length / 2
    const words = [...leftWords, ...Array<number>(gap).fill(0), ...rightWords]
    return wordsToBytes(words, tail)
  }
  const words = parseWords(head)
  if (words === undefined) return undefined
  if (words.length + tail.length / 2 !== 8) return undefined
  return wordsToBytes(words, tail)
}

function parseWords(text: string): number[] | undefined {
  if (text === '') return []
  const parts = text.split(':')
  if (parts.some(p => p === '')) return undefined
  const words: number[] = []
  for (const part of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined
    words.push(Number.parseInt(part, 16))
  }
  return words
}

function wordsToBytes(words: number[], ipv4Tail: number[]): Buffer {
  const bytes: number[] = []
  for (const word of words) {
    bytes.push((word >> 8) & 0xff, word & 0xff)
  }
  bytes.push(...ipv4Tail)
  return Buffer.from(bytes)
}

/** Whether `text` is an IPv4 literal. */
export function isIpv4Literal(text: string): boolean {
  const parts = text.split('.')
  return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** A SAN general name: [2] dNSName (IA5) or [7] iPAddress (raw bytes). */
function sanGeneralName(host: string): Buffer {
  const trimmed = host.trim()
  if (isIpv4Literal(trimmed)) {
    return derTag(TAG_CONTEXT_7, Buffer.from(trimmed.split('.').map(Number)))
  }
  const ipv6 = parseIpv6Bytes(trimmed)
  if (ipv6 !== undefined) return derTag(TAG_CONTEXT_7, ipv6)
  return derTag(TAG_CONTEXT_2, Buffer.from(trimmed, 'ascii'))
}

/* ------------------------------------------------------------------ */
/* Certificate building                                                */
/* ------------------------------------------------------------------ */

/** PEM-encode a DER body. */
export function pemEncode(label: string, der: Buffer): string {
  const base64 = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`
}

/** Options for {@link generateSelfSignedCert}. */
export interface SelfSignedCertOptions {
  /** SAN host entries: DNS names and/or IP literals. */
  hosts: readonly string[]
  /** Validity in days. */
  days: number
  /** Subject CN; defaults to the first host. */
  commonName?: string
}

/** A freshly generated key pair plus the signed leaf certificate. */
export interface SelfSignedResult {
  certDer: Buffer
  certPem: string
  keyPem: string
  publicKey: KeyObject
  privateKey: KeyObject
}

/**
 * Generate a self-signed X.509 v3 leaf certificate for `hosts`.
 * @param options - hosts, validity, subject.
 * @returns DER + PEM certificate, PEM private key, and the key objects.
 */
export function generateSelfSignedCert(options: SelfSignedCertOptions): SelfSignedResult {
  const hosts = options.hosts.map(h => h.trim()).filter(h => h !== '')
  if (hosts.length === 0) throw new Error('self-signed certificate needs at least one host')
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  })
  const commonName = options.commonName?.trim() || hosts[0]!

  // TBSCertificate ------------------------------------------------------
  const serial = randomBytes(16)
  serial[0]! &= 0x7f // positive integer

  const issuer = derSeq(derSet(derSeq(derOid('2.5.4.3'), derUtf8String(commonName))))
  const subject = issuer // self-signed: same name

  const notBefore = new Date(Date.now() - 3600_000) // 1h skew allowance
  const notAfter = new Date(notBefore.getTime() + options.days * 86_400_000)
  const validity = derSeq(derUtcTime(notBefore), derUtcTime(notAfter))

  // subjectPublicKeyInfo = the full SPKI DER produced by node.
  const spki = publicKey.export({ type: 'spki', format: 'der' })

  // Extensions ----------------------------------------------------------
  const basicConstraints = derSeq(
    derOid('2.5.29.19'),
    derBoolean(true), // critical
    derOctetString(derSeq()), // CA:FALSE → empty SEQUENCE
  )
  const keyUsage = derSeq(
    derOid('2.5.29.15'),
    derBoolean(true), // critical
    // KeyUsage is a BIT STRING with MSB-first bit numbering: bit 0 =
    // digitalSignature, bit 2 = keyEncipherment → 1010 0000 = 0xa0.
    derOctetString(derBitString(Buffer.from([0xa0]))),
  )
  const extendedKeyUsage = derSeq(
    derOid('2.5.29.37'),
    derOctetString(derSeq(derOid('1.3.6.1.5.5.7.3.1'))), // serverAuth
  )
  const subjectAltName = derSeq(
    derOid('2.5.29.17'),
    derOctetString(derSeq(...hosts.map(sanGeneralName))),
  )
  const extensions = derSeq(basicConstraints, keyUsage, extendedKeyUsage, subjectAltName)
  const extensionsWrapper = derTag(0xa3, extensions) // [3] EXPLICIT Extensions

  const tbs = derSeq(
    derTag(0xa0, derInt(Buffer.from([2]))), // version [0] EXPLICIT v3
    derInt(serial),
    sha256WithRsa(),
    issuer,
    validity,
    subject,
    spki,
    extensionsWrapper,
  )

  // Signature -----------------------------------------------------------
  const signature = createSign('sha256').update(tbs).end().sign(privateKey)
  const certDer = derSeq(tbs, sha256WithRsa(), derBitString(signature))

  return {
    certDer,
    certPem: pemEncode('CERTIFICATE', certDer),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
    privateKey,
  }
}
