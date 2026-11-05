/**
 * @riceawa/dsh-lan-gateway — browser half.
 *
 * Two jobs:
 * 1. Insecure-origin UUID shim: the gateway can serve the GUI over plain HTTP
 *    on LAN addresses, where browsers lack `crypto.randomUUID()`. This bundle
 *    installs a getRandomValues-backed `randomUUID` on the Crypto prototype at
 *    module scope. With TLS enabled the origin is secure and the shim is a
 *    no-op.
 * 2. The gateway's configuration page body: registered into the official
 *    Plugins page as THIS bundle's own configuration
 *    (`plugins.bundle.config`, keyed by the package name), with its copy in a
 *    locale namespace so the card follows Settings → Language, and its fields
 *    staged over the platform's shared settings form (`ctx.configForms`).
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
// (`plugins.bundle.config`), the settings domain's `configForms` service, and
// the locale registry all resolve from the web shell's frozen module table.
// Importing them is what subjects the registration below to the platform's own
// contract instead of a local copy that drifts the next time upstream renames a
// slot or a service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { LanGatewayCard } from './lan-gateway-card.tsx'
import { EN, LAN_GATEWAY_LOCALE, ZH } from './locale.ts'
import { injectStyles } from './styles.ts'

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

/** The services the card rides: slots, the locale registry, and the settings form. */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Mount the settings card and the UUID shim.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  installRandomUuidShim()
  // Inserted once per page and removed with the plugin tree.
  ctx.effect(() => injectStyles(), 'dsh-lan-gateway: card styles')

  // The card's copy lives in the locale registry, so a Settings → Language
  // switch re-renders it in place (the renderer derives each entry's `t` from
  // the namespace and the locale revision). Registering before the slot means
  // the first render already has its dictionary.
  ctx.effect(() => ctx.locale.register(LAN_GATEWAY_LOCALE, { zh: ZH, en: EN }),
    'dsh-lan-gateway: locale dictionary')

  // The card is this bundle's own configuration page, and it edits through the
  // same shared form the official pages use: `configForms.get(entryId)` is a
  // revision-fenced view over the profile entry, so a save is one document
  // mutation rather than a bespoke route, and it works from any browser dsh
  // itself admits.
  //
  // It rides `plugins.bundle.config`, keyed by the bundle's package name, which
  // is the slot dsh declares for exactly this: dsh 0.1.7+ lists a bundle's own
  // configuration on the bundle's page, and it reserves `plugins.item` for the
  // official settings pages ("one companion package per host-plane namespace").
  //
  // `whileServed` keeps the entry off the page until the Host's settings mirror
  // serves this plugin's entry. That is the one gate worth having: without a
  // Loader entry there is nothing to write to, and the card would appear only
  // to fail every save.
  ctx.effect(() => ctx.configForms.whileServed([ENTRY_ID], () =>
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: PACKAGE_NAME,
      locale: LAN_GATEWAY_LOCALE,
      inject: () => ({ entryId: ENTRY_ID, configForms: ctx.configForms }),
    }, LanGatewayCard))))
}
