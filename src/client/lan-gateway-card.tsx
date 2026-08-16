/**
 * The lan-gateway settings card shown in the official DSH Settings → Plugins
 * page (the `settings.plugin.item` slot). It stages edits over the
 * `lan-gateway` settings namespace and writes them on save, mirroring the
 * shipped cards' staged form: a save is one explicit gesture, and a field's
 * effective value is the user layer over the composition layer.
 *
 * @module @dsh-external/dsh-lan-gateway/client/card
 */

import { useState, useSyncExternalStore, type ChangeEvent, type ReactNode } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * The official Settings → Plugins page declares the `settings.plugin.item`
 * list slot (kind list, root scope, empty owner share) in its own package.
 * The published package ships no `src/`, so the entry is re-declared here —
 * the runtime slot is real; this only restores the compile-time table.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One plugin's card inside the plugin configuration section. */
    'settings.plugin.item': { kind: 'list'; scope: 'root'; owner: { children?: never } }
  }
}

/** The `lan-gateway` settings section shape (subset of the host Config). */
export interface LanGatewaySettings {
  enabled?: boolean
  gatewayPort?: number
  dshTargetPort?: number
  lanCidrs?: string[]
  authRequired?: boolean
  cookieMaxAgeDays?: number
  tlsEnabled?: boolean
  tlsMode?: 'self-signed' | 'custom'
  tlsCertPath?: string
  tlsKeyPath?: string
  tlsSelfSignedHosts?: string
  tlsCertMaxAgeDays?: number
}

/** What the plugin's slot entry injects: the bound scope and the translator. */
export interface LanGatewayCardFace {
  scope: SettingsScope<LanGatewaySettings>
  t: (key: string) => string
}

/** Props the renderer binds for this card. */
export type LanGatewayCardProps =
  PropsRuntime<'settings.plugin.item'>
  & InjectFace<LanGatewayCardFace>

/* ------------------------------------------------------------------ */
/* Field model                                                         */
/* ------------------------------------------------------------------ */

type FieldKind = 'boolean' | 'number' | 'text' | 'cidrs' | 'select'

interface FieldDef {
  field: keyof LanGatewaySettings
  kind: FieldKind
  optional?: boolean
  options?: readonly string[]
}

const FIELDS: readonly FieldDef[] = [
  { field: 'enabled', kind: 'boolean' },
  { field: 'gatewayPort', kind: 'number' },
  { field: 'dshTargetPort', kind: 'number', optional: true },
  { field: 'lanCidrs', kind: 'cidrs' },
  { field: 'authRequired', kind: 'boolean' },
  { field: 'cookieMaxAgeDays', kind: 'number' },
  { field: 'tlsEnabled', kind: 'boolean' },
  { field: 'tlsMode', kind: 'select', options: ['self-signed', 'custom'] },
  { field: 'tlsSelfSignedHosts', kind: 'text' },
  { field: 'tlsCertPath', kind: 'text', optional: true },
  { field: 'tlsKeyPath', kind: 'text', optional: true },
]

/** Render a stored value as draft text. */
function formatValue(def: FieldDef, value: unknown): string {
  switch (def.kind) {
    case 'boolean': return value === true ? 'true' : 'false'
    case 'number': return typeof value === 'number' ? String(value) : ''
    case 'cidrs': return Array.isArray(value) ? value.join(', ') : ''
    case 'select': return typeof value === 'string' ? value : (def.options?.[0] ?? '')
    case 'text': return typeof value === 'string' ? value : ''
  }
}

type Write = { kind: 'set'; value: unknown } | { kind: 'clear' }

/** Parse draft text into a write; undefined blocks the save (invalid). */
function parseValue(def: FieldDef, text: string): Write | undefined {
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
    case 'text':
      return trimmed === '' ? (def.optional ? { kind: 'clear' } : undefined) : { kind: 'set', value: trimmed }
  }
}

/* ------------------------------------------------------------------ */
/* Staged form                                                         */
/* ------------------------------------------------------------------ */

interface Draft {
  text: string
  clear: boolean
}

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

/**
 * Render the LAN gateway card.
 * @param props - injected scope + translator.
 * @returns the card, or nothing while the namespace is not served.
 */
export function LanGatewayCard({ scope, t }: LanGatewayCardProps) {
  const snapshot = useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
  )
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)

  if (snapshot.status !== 'ready') return null
  const writable = snapshot.writable
  const disabled = !writable || saving

  const effective = (field: keyof LanGatewaySettings): unknown =>
    (snapshot.value as Record<string, unknown> | undefined)?.[field]
  const baseOf = (field: keyof LanGatewaySettings): unknown =>
    (snapshot.base as Record<string, unknown> | undefined)?.[field]
  const userLayer = snapshot.user as Record<string, unknown> | undefined
  const overridden = (field: string): boolean =>
    userLayer !== undefined && Object.hasOwn(userLayer, field)

  const draftOf = (def: FieldDef): Draft =>
    drafts[def.field] ?? { text: formatValue(def, effective(def.field)), clear: false }

  const stage = (field: string, draft: Draft): void => {
    setDrafts(prev => ({ ...prev, [field]: draft }))
    setFailed(false)
  }

  const resetField = (def: FieldDef): void => {
    stage(def.field, { text: formatValue(def, baseOf(def.field)), clear: true })
  }

  const discard = (): void => {
    setDrafts({})
    setFailed(false)
  }

  const invalid = (): boolean =>
    Object.entries(drafts).some(([field, draft]) => {
      if (draft.clear) return false
      const def = FIELDS.find(f => f.field === field)
      return def === undefined || parseValue(def, draft.text) === undefined
    })

  const save = async (): Promise<void> => {
    const entries = Object.entries(drafts)
    if (entries.length === 0 || saving || invalid()) return
    setSaving(true)
    setFailed(false)
    try {
      for (const [field, draft] of entries) {
        const def = FIELDS.find(f => f.field === field)
        if (def === undefined) continue
        if (draft.clear) {
          await scope.unset(field)
        } else {
          const write = parseValue(def, draft.text)
          if (write === undefined) continue
          if (write.kind === 'clear') await scope.unset(field)
          else await scope.set(field, write.value)
        }
      }
      // The Host is the authority: verify every staged edit landed in the
      // raw user layer; anything missing keeps the card dirty.
      const latest = scope.getSnapshot()
      const user = latest.user as Record<string, unknown> | undefined
      const landed = entries.every(([field, draft]) =>
        draft.clear ? (user === undefined || !Object.hasOwn(user, field)) : (user !== undefined && Object.hasOwn(user, field)),
      )
      if (landed) setDrafts({})
      else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const dirty = Object.keys(drafts).length > 0

  const renderControl = (def: FieldDef): ReactNode => {
    const draft = draftOf(def)
    const field = def.field
    const labelKey = `field.${field}`
    const label = t(labelKey)
    const hintKey = `hint.${field}`
    const hint = t(hintKey)
    const isOverridden = overridden(field)
    switch (def.kind) {
      case 'boolean':
        return (
          <label style={styles.checkRow}>
            <input
              type="checkbox"
              checked={draft.text === 'true'}
              disabled={disabled}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                stage(field, { text: e.target.checked ? 'true' : 'false', clear: false })}
            />
            <span>{label}</span>
            {isOverridden ? <em style={styles.overridden}>{t('overridden')}</em> : null}
            <button type="button" disabled={disabled || !isOverridden} onClick={() => resetField(def)}>
              {t('reset')}
            </button>
          </label>
        )
      case 'select':
        return (
          <div style={styles.field}>
            <label style={styles.label} htmlFor={`lan-gw-${field}`}>{label}</label>
            <select
              id={`lan-gw-${field}`}
              value={draft.text}
              disabled={disabled}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                stage(field, { text: e.target.value, clear: false })}
            >
              {def.options?.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
            {isOverridden ? <em style={styles.overridden}>{t('overridden')}</em> : null}
            <button type="button" disabled={disabled || !isOverridden} onClick={() => resetField(def)}>
              {t('reset')}
            </button>
          </div>
        )
      default:
        return (
          <div style={styles.field}>
            <label style={styles.label} htmlFor={`lan-gw-${field}`}>{label}</label>
            <input
              id={`lan-gw-${field}`}
              type={def.kind === 'number' ? 'number' : 'text'}
              value={draft.text}
              disabled={disabled}
              placeholder={def.optional ? t('emptyMeansClear') : undefined}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                stage(field, { text: e.target.value, clear: false })}
            />
            {hint !== labelKey && hint !== '' ? <span style={styles.hint}>{hint}</span> : null}
            <span style={styles.rowRight}>
              {isOverridden ? <em style={styles.overridden}>{t('overridden')}</em> : null}
              <button type="button" disabled={disabled || !isOverridden} onClick={() => resetField(def)}>
                {t('reset')}
              </button>
            </span>
          </div>
        )
    }
  }

  return (
    <li style={styles.card}>
      <button
        type="button"
        style={styles.header}
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span style={styles.headerText}>
          <span style={styles.name}>{t('title')}</span>
          <span style={styles.description}>{t('description')}</span>
        </span>
        {dirty ? <span style={styles.pending}>{t('unsaved')}</span> : null}
        <span style={{ ...styles.chevron, ...(open ? styles.chevronOpen : {}) }}>{open ? '▾' : '▸'}</span>
      </button>
      {open
        ? (
          <div style={styles.body}>
            {!writable ? <p style={styles.readOnly} role="status">{t('readOnly')}</p> : null}
            {FIELDS.map(def => <div key={def.field}>{renderControl(def)}</div>)}
            <div style={styles.footer}>
              {failed ? <p style={styles.failed} role="status">{t('saveFailed')}</p> : null}
              <button type="button" disabled={!dirty || saving} onClick={discard}>{t('discard')}</button>
              <button
                type="button"
                disabled={!dirty || invalid() || saving}
                onClick={() => { void save() }}
              >
                {saving ? t('saving') : t('save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}

/* ------------------------------------------------------------------ */
/* Styling (inline — no CSS modules in this bundle)                    */
/* ------------------------------------------------------------------ */

const styles: Record<string, React.CSSProperties> = {
  card: {
    listStyle: 'none',
    border: '1px solid #2a3040',
    borderRadius: '10px',
    background: '#141821',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    padding: '12px 14px',
    border: 0,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  },
  headerText: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1, minWidth: 0 },
  name: { fontSize: '14px', fontWeight: 600, color: '#e6e9ef' },
  description: { fontSize: '12px', color: '#8b93a3' },
  pending: {
    fontSize: '11px', color: '#f0c36d', border: '1px solid #f0c36d66',
    borderRadius: '999px', padding: '1px 8px', whiteSpace: 'nowrap',
  },
  chevron: { color: '#8b93a3', fontSize: '12px' },
  chevronOpen: { transform: 'rotate(180deg)' },
  body: { padding: '12px 14px', borderTop: '1px solid #2a3040', display: 'flex', flexDirection: 'column', gap: '10px' },
  field: { display: 'flex', flexDirection: 'column', gap: '4px' },
  label: { fontSize: '12px', color: '#aab2c1' },
  hint: { fontSize: '11px', color: '#6b7488' },
  checkRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#e6e9ef' },
  rowRight: { display: 'flex', alignItems: 'center', gap: '8px' },
  overridden: { fontSize: '11px', color: '#f0c36d', fontStyle: 'normal' },
  readOnly: { fontSize: '12px', color: '#8b93a3', margin: 0 },
  footer: { display: 'flex', justifyContent: 'flex-end', gap: '8px', alignItems: 'center', marginTop: '4px' },
  failed: { fontSize: '12px', color: '#ff7b72', margin: 0, marginRight: 'auto' },
}
