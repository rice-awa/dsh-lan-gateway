/**
 * TLS material management for the gateway: self-signed certificates are
 * generated once and persisted under `~/.dsh/lan-gateway/tls/` (0600) so
 * restarts reuse the same certificate instead of minting a new one every
 * boot; custom certificates are read straight from user-supplied PEM paths.
 *
 * @module @riceawa/dsh-lan-gateway/tls
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { X509Certificate } from 'node:crypto'
import { generateSelfSignedCert, type SelfSignedCertOptions } from './x509.ts'

/** The TLS state directory: `~/.dsh/lan-gateway/tls`. */
export function tlsDir(home: string = homedir()): string {
  return join(home, '.dsh', 'lan-gateway', 'tls')
}

export const SELF_SIGNED_CERT_FILE = 'selfsigned.crt'
export const SELF_SIGNED_KEY_FILE = 'selfsigned.key'

/** In-memory TLS material handed to the HTTPS server. */
export interface TlsMaterial {
  cert: string
  key: string
}

/** Options controlling self-signed certificate creation. */
export interface SelfSignedTlsOptions {
  hosts: readonly string[]
  days: number
  commonName?: string
}

function privateWrite(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {}
}

/**
 * Load the persisted self-signed certificate, generating it on first use.
 * @param opts - hosts / validity for a fresh certificate.
 * @param home - dsh home override (tests).
 * @returns the material and whether it was just created.
 */
export function loadOrCreateSelfSigned(
  opts: SelfSignedTlsOptions,
  home: string = homedir(),
): { material: TlsMaterial; created: boolean } {
  const dir = tlsDir(home)
  const certPath = join(dir, SELF_SIGNED_CERT_FILE)
  const keyPath = join(dir, SELF_SIGNED_KEY_FILE)
  if (existsSync(certPath) && existsSync(keyPath)) {
    try {
      const cert = readFileSync(certPath, 'utf8')
      const key = readFileSync(keyPath, 'utf8')
      new X509Certificate(cert) // sanity: must parse as a certificate
      return { material: { cert, key }, created: false }
    } catch {
      // Corrupt or unreadable persisted material — regenerate below.
    }
  }
  const material = generateSelfSignedMaterial(opts)
  mkdirSync(dir, { recursive: true })
  privateWrite(keyPath, material.key)
  privateWrite(certPath, material.cert)
  return { material, created: true }
}

/**
 * Force-regenerate the self-signed certificate (new key + cert), replacing
 * the persisted files. Used by `lan_gateway tls-regenerate`.
 */
export function regenerateSelfSigned(opts: SelfSignedTlsOptions, home: string = homedir()): TlsMaterial {
  const dir = tlsDir(home)
  mkdirSync(dir, { recursive: true })
  const material = generateSelfSignedMaterial(opts)
  privateWrite(join(dir, SELF_SIGNED_KEY_FILE), material.key)
  privateWrite(join(dir, SELF_SIGNED_CERT_FILE), material.cert)
  return material
}

function generateSelfSignedMaterial(opts: SelfSignedTlsOptions): TlsMaterial {
  const hosts = opts.hosts.map(h => h.trim()).filter(h => h !== '')
  if (hosts.length === 0) {
    throw new Error('self-signed TLS needs at least one host in tlsSelfSignedHosts')
  }
  const certOptions: SelfSignedCertOptions = {
    hosts,
    days: opts.days,
    ...(opts.commonName !== undefined ? { commonName: opts.commonName } : {}),
  }
  const { certPem, keyPem } = generateSelfSignedCert(certOptions)
  return { cert: certPem, key: keyPem }
}

/**
 * Load a user-supplied certificate + key pair from PEM files.
 * @param certPath - path to the PEM certificate (or chain).
 * @param keyPath - path to the PEM private key.
 * @returns the material.
 */
export function loadCustomCert(certPath: string, keyPath: string): TlsMaterial {
  if (certPath === '') throw new Error('tlsMode=custom requires tlsCertPath (PEM certificate)')
  if (keyPath === '') throw new Error('tlsMode=custom requires tlsKeyPath (PEM private key)')
  let cert: string
  try {
    cert = readFileSync(certPath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read TLS certificate "${certPath}": ${errorMessage(error)}`)
  }
  let key: string
  try {
    key = readFileSync(keyPath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read TLS private key "${keyPath}": ${errorMessage(error)}`)
  }
  try {
    new X509Certificate(cert)
  } catch {
    throw new Error(`"${certPath}" does not contain a valid PEM certificate`)
  }
  return { cert, key }
}

/** Parse the user-facing `tlsSelfSignedHosts` string into SAN entries. */
export function parseSelfSignedHosts(text: string | undefined): string[] {
  return (text ?? '')
    .split(/[,;]/)
    .map(host => host.trim())
    .filter(host => host !== '')
    .slice(0, 32)
}

/** Readable summary of a PEM certificate for `status` output. */
export interface CertInfo {
  subject: string
  issuer: string
  validFrom: string
  validTo: string
  fingerprint256: string
  san?: string
}

/** Describe a PEM certificate (throws on malformed input). */
export function describeCert(certPem: string): CertInfo {
  const cert = new X509Certificate(certPem)
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: cert.validFrom,
    validTo: cert.validTo,
    fingerprint256: cert.fingerprint256,
    ...(cert.subjectAltName !== undefined ? { san: cert.subjectAltName } : {}),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
