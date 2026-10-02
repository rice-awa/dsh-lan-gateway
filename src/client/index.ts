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
 *    page as THIS bundle's own configuration (`plugins.bundle.config`, keyed by
 *    the package name), so port, CIDRs, auth, and TLS stay adjustable from the
 *    GUI on the plugin's own page. `plugins.item` is deliberately not used: dsh
 *    reserves it for the official settings pages, one companion package per
 *    host-plane namespace, and a bundle's configuration belongs in its own
 *    config slot instead.
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
// Type-only, and never bundled: the `slots` service declaration (owned by the
// renderer, which installs the registry), the Plugins page's slot contract
// (`plugins.bundle.config`), and the settings domain's `configForms` service all
// resolve from the web shell's frozen module table. Importing them is what
// subjects the registration below to the platform's own contract instead of a
// local copy that drifts the next time upstream renames a slot or a service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { LanGatewayCard } from './lan-gateway-card.tsx'

export const name = 'dsh-lan-gateway'

/**
 * The package name dsh keys a bundle's own configuration by in
 * `plugins.bundle.config`, and the name this profile's bundle row resolves to.
 * It is the package's npm name — not the locale namespace or the row id.
 */
const PACKAGE_NAME = '@riceawa/dsh-lan-gateway'

/**
 * The profile entry id this plugin's bundle patch composes it under. dsh >=
 * 0.1.7 addresses both settings writes and the serve gate by entry id.
 */
const ENTRY_ID = 'dsh-lan-gateway'

/** The slots service the card rides, and the settings mirror the gate reads. */
export const inject = ['slots', 'configForms']

/**
 * Mount the settings card and the UUID shim.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  installRandomUuidShim()

  // The card is this bundle's own configuration page. Like ModLens it registers
  // with no inject face and fetches its own loopback config route, so it depends
  // on no settings, locale, or connection service.
  //
  // It rides `plugins.bundle.config`, keyed by the bundle's package name, which
  // is the slot dsh declares for exactly this: dsh 0.1.7+ lists a bundle's own
  // configuration on the bundle's page, and it reserves `plugins.item` for the
  // official settings pages ("one companion package per host-plane namespace").
  // Registering there made the card pose as an official plugin; the dsh 0.2
  // Plugins page still declares that slot, so nothing failed loudly.
  //
  // `whileServed` keeps the entry off the page until the Host's settings mirror
  // serves this plugin's entry. That is the one gate worth having: without a
  // Loader entry there is nothing to write to, and the card would appear only
  // to fail every save with the route's 409.
  ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () =>
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: PACKAGE_NAME,
    }, LanGatewayCard))))
}
