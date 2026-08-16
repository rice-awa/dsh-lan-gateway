/**
 * @dsh-external/dsh-lan-gateway — insecure-origin UUID shim (client half).
 *
 * The gateway serves the DSH web GUI over plain HTTP on a LAN address
 * (http://<lan-ip>:3081). Browsers treat that origin as insecure, so the
 * Web API `crypto.randomUUID()` — which the GUI's wire layer uses for every
 * RPC/message id — is `undefined`, and opening workspaces (or workspaces
 * opened from other devices) fails with "crypto.randomUUID is not a
 * function". `crypto.getRandomValues()` has no such restriction.
 *
 * This bundle installs a getRandomValues-backed `randomUUID` on the browser
 * `Crypto` prototype at module scope — before any official code path mints
 * an id — so every existing call site (`crypto.randomUUID()`) works from
 * gateway-served origins without touching DSH source. It is a no-op on
 * secure origins and on Node (≥19).
 */

/** RFC 4122 v4 UUID from crypto.getRandomValues (available on insecure origins). */
function uuidFromRandomValues(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40)
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80)
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Install `randomUUID` on the browser Crypto prototype when the platform
 * lacks it. Idempotent; re-checks every call.
 * @returns `true` when the shim was installed by this call.
 */
export function installRandomUuidShim(): boolean {
  const cryptoObj = globalThis.crypto
  if (cryptoObj === undefined) return false
  if (typeof cryptoObj.randomUUID === 'function') return false
  if (typeof cryptoObj.getRandomValues !== 'function') return false
  try {
    // Browsers expose crypto.randomUUID through the Crypto prototype; patching
    // the prototype (not the instance) covers `crypto.randomUUID()` everywhere.
    const proto = Object.getPrototypeOf(cryptoObj) as { randomUUID?: unknown } | null
    if (proto !== null && typeof proto.randomUUID !== 'function') {
      Object.defineProperty(proto, 'randomUUID', {
        value: uuidFromRandomValues,
        writable: true,
        configurable: true,
      })
      return true
    }
    // Fallback: direct instance property (sandboxed/odd environments).
    Object.defineProperty(cryptoObj, 'randomUUID', {
      value: uuidFromRandomValues,
      writable: true,
      configurable: true,
    })
    return true
  } catch {
    return false
  }
}

// Module scope: the shim is live as soon as this bundle is evaluated, before
// any RPC/session code runs. apply() re-runs it as a belt-and-braces re-check.
installRandomUuidShim()

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-lan-gateway'

/** Client apply: nothing to orchestrate — the patch is module-scoped. */
export function apply(_ctx: Context): void {
  installRandomUuidShim()
}
