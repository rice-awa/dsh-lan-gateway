/**
 * The lan-gateway settings card shown in the official DSH Settings → Plugins
 * page (the `settings.plugin.item` slot).
 *
 * ModLens-style: the card carries NO injected services. It reads and writes
 * the loopback-only `/lan-gateway/config` host route (the browser never sees
 * the settings seam or any secret), so the client bundle's only dependency is
 * the `slots` service that every plugin already has.
 *
 * @module @riceawa/dsh-lan-gateway/client/card
 */

import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

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

/** Props the renderer binds for this card (unused — the card is self-loading). */
export type LanGatewayCardProps = PropsRuntime<'settings.plugin.item'>

/** The wire shape of the `lan-gateway` config section. */
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

/** GET /lan-gateway/config response. */
interface RouteState {
  config: LanGatewaySettings
  running: boolean
  port: number
  tls: string
  lastError: string | null
}

/* ------------------------------------------------------------------ */
/* Bilingual copy (ModLens-style: two small sets, picked by browser)   */
/* ------------------------------------------------------------------ */

interface Labels {
  title: string
  description: string
  unsaved: string
  save: string
  saving: string
  discard: string
  reset: string
  overridden: string
  readOnly: string
  saveFailed: string
  loadFailed: string
  emptyMeansClear: string
  running: string
  stopped: string
  tls: string
  lastError: string
  [key: `field.${string}`]: string
  [key: `hint.${string}`]: string
}

const LABELS: Record<'zh' | 'en', Labels> = {
  zh: {
    title: 'LAN 网关',
    description: '远程访问开关、端口、TLS 证书、受信网段等网关设置',
    unsaved: '未保存',
    save: '保存',
    saving: '保存中…',
    discard: '放弃',
    reset: '重置',
    overridden: '已覆盖',
    readOnly: '网关设置当前不可用（读不到配置路由）。',
    saveFailed: '保存未生效，请检查输入后重试。',
    loadFailed: '加载网关配置失败。',
    emptyMeansClear: '留空 = 使用默认',
    running: '运行中',
    stopped: '已停止',
    tls: 'TLS',
    lastError: '上次错误',
    'field.enabled': '启用网关',
    'hint.enabled': '启动时监听 0.0.0.0 网关端口',
    'field.gatewayPort': '网关端口',
    'hint.gatewayPort': '绑定到 0.0.0.0 的监听端口（默认 3081）',
    'field.dshTargetPort': 'dsh 目标端口',
    'hint.dshTargetPort': '留空则自动跟随 dsh web 端口（默认 3080）',
    'field.lanCidrs': '免密 LAN 网段',
    'hint.lanCidrs': '逗号分隔的 CIDR，如 10.0.0.0/8, 192.168.0.0/16',
    'field.authRequired': '非 LAN 访问需要密码',
    'hint.authRequired': '公网来源必须登录后才能访问',
    'field.cookieMaxAgeDays': '会话有效期（天）',
    'hint.cookieMaxAgeDays': '登录 cookie 的存活天数（默认 7）',
    'field.tlsEnabled': '启用 TLS（HTTPS）',
    'hint.tlsEnabled': '以 HTTPS 提供网关服务',
    'field.tlsMode': '证书来源',
    'hint.tlsMode': 'self-signed = 自动生成自签名证书；custom = 使用自己的证书',
    'field.tlsSelfSignedHosts': '自签名证书域名/IP',
    'hint.tlsSelfSignedHosts': '逗号分隔，写入证书 SAN，如 localhost, 192.168.1.5',
    'field.tlsCertPath': '证书文件路径（custom）',
    'hint.tlsCertPath': 'PEM 格式证书（或证书链）的绝对路径',
    'field.tlsKeyPath': '私钥文件路径（custom）',
    'hint.tlsKeyPath': '与证书配套的 PEM 私钥绝对路径',
    'field.tlsCertMaxAgeDays': '自签名证书有效期（天）',
    'hint.tlsCertMaxAgeDays': '默认 825（约 27 个月）',
  },
  en: {
    title: 'LAN Gateway',
    description: 'Remote-access switch, port, TLS certificate, trusted CIDRs and more',
    unsaved: 'Unsaved',
    save: 'Save',
    saving: 'Saving…',
    discard: 'Discard',
    reset: 'Reset',
    overridden: 'overridden',
    readOnly: 'Gateway settings unavailable (config route unreachable).',
    saveFailed: 'The save did not land — check the inputs and retry.',
    loadFailed: 'Failed to load gateway configuration.',
    emptyMeansClear: 'Empty = default',
    running: 'Running',
    stopped: 'Stopped',
    tls: 'TLS',
    lastError: 'Last error',
    'field.enabled': 'Enable gateway',
    'hint.enabled': 'Listen on the gateway port at boot',
    'field.gatewayPort': 'Gateway port',
    'hint.gatewayPort': 'Port bound on 0.0.0.0 (default 3081)',
    'field.dshTargetPort': 'dsh target port',
    'hint.dshTargetPort': 'Leave empty to follow the dsh web port (default 3080)',
    'field.lanCidrs': 'Password-free LAN CIDRs',
    'hint.lanCidrs': 'Comma separated CIDRs, e.g. 10.0.0.0/8, 192.168.0.0/16',
    'field.authRequired': 'Password required for non-LAN',
    'hint.authRequired': 'Internet sources must sign in before reaching the GUI',
    'field.cookieMaxAgeDays': 'Session lifetime (days)',
    'hint.cookieMaxAgeDays': 'Login cookie lifetime (default 7)',
    'field.tlsEnabled': 'Enable TLS (HTTPS)',
    'hint.tlsEnabled': 'Serve the gateway over HTTPS',
    'field.tlsMode': 'Certificate source',
    'hint.tlsMode': 'self-signed = auto-generated certificate; custom = your own files',
    'field.tlsSelfSignedHosts': 'Self-signed hosts (SANs)',
    'hint.tlsSelfSignedHosts': 'Comma separated DNS/IP names, e.g. localhost, 192.168.1.5',
    'field.tlsCertPath': 'Certificate path (custom)',
    'hint.tlsCertPath': 'Absolute path to a PEM certificate (or chain)',
    'field.tlsKeyPath': 'Private key path (custom)',
    'hint.tlsKeyPath': 'Absolute path to the matching PEM private key',
    'field.tlsCertMaxAgeDays': 'Self-signed validity (days)',
    'hint.tlsCertMaxAgeDays': 'Default 825 (about 27 months)',
  },
}

function labels(): Labels {
  const lang = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase()
  return lang.startsWith('zh') ? LABELS.zh : LABELS.en
}

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
  { field: 'tlsCertMaxAgeDays', kind: 'number' },
]

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

/** Parse draft text into a value for the POST body; undefined blocks saving. */
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
/* Card                                                                */
/* ------------------------------------------------------------------ */

/**
 * Render the LAN gateway card. Self-loading: fetches the config route on
 * mount, posts the edited config on save.
 * @param _props - unused; the card needs no injected face.
 * @returns the card, or nothing while the route is unreachable.
 */
export function LanGatewayCard(_props: LanGatewayCardProps): ReactNode {
  const t = labels()
  const [open, setOpen] = useState(false)
  const [route, setRoute] = useState<RouteState | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/lan-gateway/config')
      .then(async (response) => {
        if (cancelled) return
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        setRoute(await response.json() as RouteState)
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => { cancelled = true }
  }, [])

  if (loadFailed) return null
  if (route === null) return null

  const { config } = route
  const draftOf = (field: keyof LanGatewaySettings): string =>
    drafts[field] ?? formatValue(FIELDS.find(f => f.field === field)!, config[field])

  const stage = (field: string, text: string): void => {
    setDrafts(prev => ({ ...prev, [field]: text }))
    setFailed(null)
  }

  const resetField = (def: FieldDef): void => {
    setDrafts(prev => {
      const next = { ...prev }
      delete next[def.field]
      return next
    })
  }

  const discard = (): void => {
    setDrafts({})
    setFailed(null)
  }

  const invalid = (): boolean =>
    Object.entries(drafts).some(([field, text]) => {
      const def = FIELDS.find(f => f.field === field)
      return def === undefined || parseValue(def, text ?? '') === undefined
    })

  const dirty = Object.keys(drafts).length > 0

  const save = async (): Promise<void> => {
    if (!dirty || saving || invalid()) return
    setSaving(true)
    setFailed(null)
    try {
      // Build the next full config: the loaded one with drafts applied.
      const next: Record<string, unknown> = {}
      for (const def of FIELDS) {
        const text = drafts[def.field] ?? formatValue(def, config[def.field])
        const write = parseValue(def, text)
        if (write === undefined) continue
        next[def.field] = write.kind === 'clear' ? null : write.value
      }
      const response = await fetch('/lan-gateway/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      })
      const body = await response.json().catch(() => ({})) as Partial<RouteState> & { error?: string }
      if (!response.ok) {
        setFailed(body.error ?? `HTTP ${response.status}`)
        return
      }
      if (body.config !== undefined) {
        setRoute({
          config: body.config,
          running: body.running ?? false,
          port: body.port ?? 0,
          tls: body.tls ?? '',
          lastError: body.lastError ?? null,
        })
      }
      setDrafts({})
    } catch {
      setFailed(t.saveFailed)
    } finally {
      setSaving(false)
    }
  }

  const renderControl = (def: FieldDef): ReactNode => {
    const field = def.field
    const label = t[`field.${field}`]
    const hint = t[`hint.${field}`]
    const text = draftOf(field)
    switch (def.kind) {
      case 'boolean':
        return (
          <div style={styles.field}>
            <label style={styles.checkRow}>
              <input
                type="checkbox"
                checked={text === 'true'}
                disabled={saving}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  stage(field, e.target.checked ? 'true' : 'false')}
              />
              <span style={styles.label}>{label}</span>
              <button
                type="button"
                style={styles.reset}
                disabled={saving || !drafts[field]}
                onClick={() => resetField(def)}
              >
                {t.reset}
              </button>
            </label>
            <span style={styles.hint}>{hint}</span>
          </div>
        )
      case 'select':
        return (
          <div style={styles.field}>
            <label style={styles.label} htmlFor={`lan-gw-${field}`}>{label}</label>
            <select
              id={`lan-gw-${field}`}
              style={styles.input}
              value={text}
              disabled={saving}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => stage(field, e.target.value)}
            >
              {def.options?.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
            <span style={styles.hint}>{hint}</span>
            <button
              type="button"
              style={styles.reset}
              disabled={saving || !drafts[field]}
              onClick={() => resetField(def)}
            >
              {t.reset}
            </button>
          </div>
        )
      default:
        return (
          <div style={styles.field}>
            <label style={styles.label} htmlFor={`lan-gw-${field}`}>{label}</label>
            <input
              id={`lan-gw-${field}`}
              style={styles.input}
              type={def.kind === 'number' ? 'number' : 'text'}
              value={text}
              disabled={saving}
              placeholder={def.optional ? t.emptyMeansClear : undefined}
              onChange={(e: ChangeEvent<HTMLInputElement>) => stage(field, e.target.value)}
            />
            <span style={styles.hint}>{hint}</span>
          </div>
        )
    }
  }

  const statusLine = `${route.running ? t.running : t.stopped} · ${t.tls}: ${route.tls} · :${route.port}`

  return (
    <li style={open ? { ...styles.card, ...styles.cardOpen } : styles.card}>
      <button
        type="button"
        style={styles.header}
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <span style={styles.headText}>
          <span style={styles.name}>{t.title}</span>
          <span style={styles.description}>{t.description}</span>
        </span>
        <span style={styles.status}>{statusLine}</span>
        {dirty ? <span style={styles.pending}>{t.unsaved}</span> : null}
        <span style={open ? { ...styles.chevron, ...styles.chevronOpen } : styles.chevron}>{open ? '▾' : '▸'}</span>
      </button>
      {open
        ? (
          <div style={styles.body}>
            {route.lastError ? <p style={styles.error} role="status">{t.lastError}: {route.lastError}</p> : null}
            {FIELDS.map(def => <div key={def.field}>{renderControl(def)}</div>)}
            <div style={styles.footer}>
              {failed ? <p style={styles.error} role="status">{failed}</p> : null}
              <button
                type="button"
                style={styles.discard}
                disabled={!dirty || saving}
                onClick={discard}
              >
                {t.discard}
              </button>
              <button
                type="button"
                style={styles.save}
                disabled={!dirty || invalid() || saving}
                onClick={() => { void save() }}
              >
                {saving ? t.saving : t.save}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}

/* ------------------------------------------------------------------ */
/* Styling — the official DSH theme tokens (light/dark aware), with    */
/* neutral fallbacks so the card never renders black-on-black or       */
/* white-on-white even if a token is missing.                          */
/* ------------------------------------------------------------------ */

/** Theme token with a fallback for token-less environments. */
function tk(token: string, fallback: string): string {
  return `var(${token}, ${fallback})`
}

const L = {
  border: tk('--dsw-alias-border-l2', 'rgba(127,127,127,0.35)'),
  bg: tk('--dsw-alias-bg-layer-3', 'transparent'),
  bgOpen: tk('--dsw-alias-bg-layer-2', 'transparent'),
  labelPrimary: tk('--dsw-alias-label-primary', 'inherit'),
  labelSecondary: tk('--dsw-alias-label-secondary', 'inherit'),
  labelTertiary: tk('--dsw-alias-label-tertiary', 'rgba(127,127,127,0.8)'),
  labelDimmed: tk('--dsw-alias-label-dimmed', 'rgba(127,127,127,0.6)'),
  error: tk('--dsw-alias-label-error', '#d1242f'),
  brand: tk('--dsw-alias-brand-primary', '#4f6ef7'),
  badgeBg: tk('--dsw-alias-bg-module-platform', 'rgba(127,127,127,0.14)'),
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    listStyle: 'none',
    border: `1px solid ${L.border}`,
    borderRadius: '12px',
    background: L.bg,
    transition: 'border-color .16s, background .16s',
    overflow: 'hidden',
  },
  cardOpen: {
    background: L.bgOpen,
    borderColor: L.labelDimmed,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    width: '100%',
    padding: '14px 16px',
    border: 0,
    background: 'none',
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  },
  headText: { display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 },
  name: { fontSize: '15px', fontWeight: 600, lineHeight: 1.4, color: L.labelPrimary },
  description: { fontSize: '13px', lineHeight: 1.5, color: L.labelTertiary },
  status: { fontSize: '11px', color: L.labelTertiary, whiteSpace: 'nowrap' },
  pending: {
    flex: 'none',
    borderRadius: '999px',
    padding: '1px 8px',
    fontSize: '11px',
    lineHeight: '17px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    background: L.badgeBg,
    color: L.labelSecondary,
  },
  chevron: { flex: 'none', color: L.labelTertiary, fontSize: '12px', transition: 'transform .16s' },
  chevronOpen: { transform: 'rotate(180deg)' },
  body: {
    borderTop: `1px solid ${L.border}`,
    margin: '0 16px',
    paddingBottom: '8px',
    display: 'flex',
    flexDirection: 'column',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '12px 0',
  },
  label: { fontSize: '13px', fontWeight: 500, lineHeight: 1.5, color: L.labelPrimary },
  hint: { margin: 0, fontSize: '12px', lineHeight: 1.5, color: L.labelTertiary },
  checkRow: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
  reset: {
    border: 'none',
    background: 'none',
    padding: 0,
    font: 'inherit',
    fontSize: '12px',
    lineHeight: 1.5,
    color: L.labelSecondary,
    cursor: 'pointer',
    alignSelf: 'flex-start',
  },
  input: {
    height: '34px',
    padding: '0 12px',
    border: `1px solid ${L.border}`,
    borderRadius: '8px',
    background: L.bg,
    font: 'inherit',
    fontSize: '13px',
    lineHeight: 1.5,
    color: L.labelPrimary,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '12px 0 4px',
    borderTop: `1px solid ${L.border}`,
  },
  error: { flex: 1, minWidth: 0, margin: 0, fontSize: '12px', lineHeight: 1.5, color: L.error },
  discard: {
    appearance: 'none',
    border: `1px solid ${L.border}`,
    borderRadius: '8px',
    padding: '5px 14px',
    font: 'inherit',
    fontSize: '13px',
    lineHeight: 1.5,
    background: 'none',
    color: L.labelSecondary,
    cursor: 'pointer',
  },
  save: {
    appearance: 'none',
    border: '1px solid transparent',
    borderRadius: '8px',
    padding: '5px 14px',
    font: 'inherit',
    fontSize: '13px',
    lineHeight: 1.5,
    background: L.labelPrimary,
    color: L.bg,
    cursor: 'pointer',
  },
}
