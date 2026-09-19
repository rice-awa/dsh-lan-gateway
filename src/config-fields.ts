/**
 * The `lan-gateway` configuration field table: which settings keys exist, how
 * each one is rendered, and how a draft string becomes a config value or a
 * clear.
 *
 * The host and the browser card share this module. The host derives the key set
 * its config route accepts and the set an empty value clears from it; the card
 * renders its controls from it. A field therefore cannot be editable on one
 * side and unknown on the other, which is what let the card silently rewrite
 * keys it never showed.
 *
 * Because both halves import it, this module must stay dependency-free and
 * side-effect-free: no schemastery (the host schema remains the validating
 * authority, not this table), no node built-ins, no DOM, no I/O.
 *
 * @module @riceawa/dsh-lan-gateway/config-fields
 */

/**
 * The wire shape of the `lan-gateway` config section, as the Settings card sees
 * it. Deliberately narrower than the host's `Config`: `cookieName` and the
 * retired `authRequired` are not card-editable. The config route applies a
 * patch, so a key absent here is left untouched rather than reset.
 */
export interface LanGatewaySettings {
  enabled?: boolean
  gatewayPort?: number
  dshTargetPort?: number
  lanCidrs?: string[]
  lanPasswordless?: boolean
  cookieMaxAgeDays?: number
  tlsEnabled?: boolean
  tlsMode?: 'self-signed' | 'custom'
  tlsCertPath?: string
  tlsKeyPath?: string
  tlsSelfSignedHosts?: string
  tlsCertMaxAgeDays?: number
  allowInsecurePlaintext?: boolean
  trustedTerminator?: string
  secureCookies?: boolean
}

/** A settings key this table knows how to edit. */
export type ConfigFieldKey = keyof LanGatewaySettings

/** How a field is rendered and parsed. */
export type FieldKind = 'boolean' | 'number' | 'text' | 'cidrs' | 'select' | 'tristate'

export interface FieldDef {
  readonly field: ConfigFieldKey
  readonly kind: FieldKind
  /** An empty draft clears the key back to the composition layer. */
  readonly optional?: boolean
  /** The accepted values of a `select` field. */
  readonly options?: readonly string[]
}

/** The three states of a tri-state field, in display order. */
export const TRISTATE_OPTIONS = ['auto', 'true', 'false'] as const

/**
 * The editable settings, in display order. Adding a config key means adding it
 * here (the host whitelist and the card's controls both follow), to the
 * `Config` schema in `index.ts`, and to `listenerKey` when it changes listener
 * behavior.
 */
export const FIELDS: readonly FieldDef[] = [
  { field: 'enabled', kind: 'boolean' },
  { field: 'gatewayPort', kind: 'number' },
  { field: 'dshTargetPort', kind: 'number', optional: true },
  { field: 'lanCidrs', kind: 'cidrs' },
  { field: 'lanPasswordless', kind: 'boolean' },
  { field: 'cookieMaxAgeDays', kind: 'number' },
  { field: 'tlsEnabled', kind: 'boolean' },
  { field: 'tlsMode', kind: 'select', options: ['self-signed', 'custom'] },
  { field: 'tlsSelfSignedHosts', kind: 'text' },
  { field: 'tlsCertPath', kind: 'text', optional: true },
  { field: 'tlsKeyPath', kind: 'text', optional: true },
  { field: 'tlsCertMaxAgeDays', kind: 'number' },
  { field: 'allowInsecurePlaintext', kind: 'boolean' },
  { field: 'trustedTerminator', kind: 'text', optional: true },
  { field: 'secureCookies', kind: 'tristate' },
]

/** Every settings key the config route accepts; anything else is ignored. */
export const CONFIG_FIELD_KEYS: ReadonlySet<string> = new Set(FIELDS.map(def => def.field as string))

/** Keys an empty submitted value clears back to the composition layer. */
export const OPTIONAL_CONFIG_KEYS: ReadonlySet<string> = new Set(
  FIELDS.filter(def => def.optional === true).map(def => def.field as string),
)

/** Render a stored value as draft text. */
export function formatValue(def: FieldDef, value: unknown): string {
  switch (def.kind) {
    case 'boolean': return value === true ? 'true' : 'false'
    case 'number': return typeof value === 'number' ? String(value) : ''
    case 'cidrs': return Array.isArray(value) ? value.join(', ') : ''
    case 'select': return typeof value === 'string' ? value : (def.options?.[0] ?? '')
    // Tri-state: an unset value is a distinct third state ("auto"), never "false".
    case 'tristate': return value === true ? 'true' : value === false ? 'false' : 'auto'
    case 'text': return typeof value === 'string' ? value : ''
  }
}

/** One field's contribution to a config patch. */
export type Write = { kind: 'set'; value: unknown } | { kind: 'clear' }

/** Parse draft text into a value for the POST body; undefined blocks saving. */
export function parseValue(def: FieldDef, text: string): Write | undefined {
  const trimmed = text.trim()
  switch (def.kind) {
    case 'boolean':
      if (trimmed === 'true') return { kind: 'set', value: true }
      if (trimmed === 'false') return { kind: 'set', value: false }
      return undefined
    case 'number':
      if (trimmed === '') return def.optional ? { kind: 'clear' } : undefined
      if (!/^\d+$/.test(trimmed)) return undefined
      return { kind: 'set', value: Number(trimmed) }
    case 'cidrs': {
      const cidrs = trimmed.split(',').map(s => s.trim()).filter(s => s !== '')
      return cidrs.length === 0 ? { kind: 'clear' } : { kind: 'set', value: cidrs }
    }
    case 'select':
      return def.options?.includes(trimmed) ? { kind: 'set', value: trimmed } : undefined
    case 'tristate':
      // 'auto' clears the key so it re-inherits the composition layer (and the
      // resolution rule), which is what an unset tri-state means.
      if (trimmed === 'auto') return { kind: 'clear' }
      if (trimmed === 'true') return { kind: 'set', value: true }
      if (trimmed === 'false') return { kind: 'set', value: false }
      return undefined
    case 'text':
      return trimmed === '' ? (def.optional ? { kind: 'clear' } : undefined) : { kind: 'set', value: trimmed }
  }
}
