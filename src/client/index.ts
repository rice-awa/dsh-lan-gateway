/**
 * @dsh-external/dsh-lan-gateway — browser half.
 *
 * Two jobs:
 * 1. Insecure-origin UUID shim: the gateway can serve the GUI over plain HTTP
 *    on LAN addresses, where browsers lack `crypto.randomUUID()`. This bundle
 *    installs a getRandomValues-backed `randomUUID` on the Crypto prototype at
 *    module scope. With TLS enabled the origin is secure and the shim is a
 *    no-op.
 * 2. Settings card: registers the LAN gateway card into the official
 *    Settings → Plugins page (`settings.plugin.item` slot), editing the
 *    `lan-gateway` settings namespace so port, CIDRs, auth, and TLS are
 *    adjustable from the GUI.
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

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { LanGatewayCard } from './lan-gateway-card.tsx'

export const name = 'dsh-lan-gateway'

/** Only the slots service: the card itself is self-loading (ModLens-style). */
export const inject = ['slots']

/**
 * Mount the settings card and the UUID shim.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  installRandomUuidShim()

  // The card rides the official Plugins → Configurable tab. Like ModLens, it
  // registers with no inject face and fetches its own loopback config route,
  // so it has no settings/locale/connection service dependencies.
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      id: 'lan-gateway',
      order: 30,
    }, LanGatewayCard)
  })
}
