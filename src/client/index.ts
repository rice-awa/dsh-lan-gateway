/**
 * @riceawa/dsh-lan-gateway — browser half.
 *
 * Two jobs:
 * 1. Insecure-origin UUID shim: the gateway can serve the GUI over plain HTTP
 *    on LAN addresses, where browsers lack `crypto.randomUUID()`. This bundle
 *    installs a getRandomValues-backed `randomUUID` on the Crypto prototype at
 *    module scope. With TLS enabled the origin is secure and the shim is a
 *    no-op.
 * 2. Settings card: registers the LAN gateway card into the official Plugins
 *    page (`plugins.item` slot) so port, CIDRs, auth, and TLS stay adjustable
 *    from the GUI.
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
// Type-only, and never bundled: the Plugins page's slot contract (`plugins.item`)
// and the settings domain's `configForms` service both resolve from the web
// shell's frozen module table. Importing them is what subjects the registration
// below to the platform's own contract instead of a local copy that drifts the
// next time upstream renames a slot.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { LanGatewayCard, cardTitle } from './lan-gateway-card.tsx'

export const name = 'dsh-lan-gateway'

/**
 * The profile entry id this plugin's bundle patch composes it under, and the
 * settings namespace dsh ≥ 0.1.7 addresses every write by.
 */
const ENTRY_ID = 'dsh-lan-gateway'

/** The slots service the card rides, and the settings mirror the gate reads. */
export const inject = ['slots', 'configForms']

/**
 * Mount the settings card and the UUID shim.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  installRandomUuidShim()

  // The card rides the official Plugins page. Like ModLens it registers with no
  // inject face and fetches its own loopback config route, so it depends on no
  // settings, locale, or connection service.
  //
  // dsh 0.1.7 replaced the namespace-keyed `settings.plugin.item` slot with the
  // list slot `plugins.item`, which is where a host-plane plugin's own
  // configuration page belongs ("one companion package per host-plane
  // namespace"); the page renders the contribution as the card's one-liner and,
  // once opened, as the body of the plugin's own page. Registering into the
  // retired slot left the card invisible on 0.1.7.
  //
  // `whileServed` keeps the entry off the page until the Host's settings mirror
  // serves this plugin's entry. That is the one gate worth having: without a
  // Loader entry there is nothing to write to, and the card would appear only
  // to fail every save with the route's 409.
  ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () =>
    ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item',
      id: ENTRY_ID,
      order: 30,
      label: () => cardTitle(),
    }, LanGatewayCard))))
}
