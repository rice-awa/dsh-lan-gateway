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
import {
  FIELDS,
  TRISTATE_OPTIONS,
  formatValue,
  parseValue,
  type FieldDef,
  type LanGatewaySettings,
} from '../config-fields.ts'

/**
 * The official Settings → Plugins page declares the `settings.plugin.item`
 * slot keyed by the settings namespace each card edits (newer DSH releases;
 * older releases dispatched it as a list slot by `id`). The published package
 * ships no `src/`, so the entry is re-declared here — the runtime slot is
 * real; this only restores the compile-time table.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One plugin's card inside the plugin configuration section. */
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: { children?: never } }
  }
}

/**
 * Props the renderer binds for this card (unused — the card is self-loading).
 */
export type LanGatewayCardProps = PropsRuntime<'settings.plugin.item'>

/**
 * The card's field table and value codecs live in `config-fields.ts`, shared
 * with the host: the host's config route decides which submitted keys are
 * editable and which empty value means "clear", and a table duplicated here
 * would let the two disagree about a field the card can render but the route
 * would refuse. Re-exported so the existing tests keep their import path.
 */
export { FIELDS, TRISTATE_OPTIONS, formatValue, parseValue }
export type { FieldDef, LanGatewaySettings }

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
  [key: `opt.${string}`]: string
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
    readOnly: '网关设置只能在宿主机本机打开 dsh web 时修改：配置路由仅监听回环地址，经网关远程访问的浏览器会被拒绝。远程请改用 lan_gateway 工具。',
    saveFailed: '保存未生效，请检查输入后重试。',
    loadFailed: '无法读取网关配置',
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
    'field.lanPasswordless': 'LAN 免登录',
    'hint.lanPasswordless': 'LAN/回环来源跳过网关登录页，但仍共用同一上游会话（需 dsh ≥ 0.1.2）',
    'field.allowInsecurePlaintext': '允许明文 HTTP',
    'hint.allowInsecurePlaintext': '危险：关闭 TLS 或受信终止代理时仍启动监听，密码与会话将以明文传输',
    'field.trustedTerminator': '受信 TLS 终止代理',
    'hint.trustedTerminator': '可选：声明前置代理标识，视为加密入口（如 nginx）。留空 = 未声明。注意：登录限流以 TCP 源地址为键，代理之后所有浏览器共用一个额度（5 次/分钟）',
    'field.secureCookies': '会话 cookie 的 Secure 属性',
    'hint.secureCookies': '自动 = TLS 或已声明受信终止代理时加 Secure。受信代理只做明文鉴权、浏览器走 http 访问时须设为 false，否则浏览器拒收 Secure cookie，登录会无限弹回登录页',
    'opt.auto': '自动',
    'opt.true': '始终 Secure',
    'opt.false': '不加 Secure（明文浏览器入口）',
    'field.cookieMaxAgeDays': '会话有效期（天）',
    'hint.cookieMaxAgeDays': '登录 cookie 的存活天数（默认 7）',
    'field.tlsEnabled': '启用 TLS（HTTPS）',
    'hint.tlsEnabled': '以 HTTPS 提供网关服务',
    'field.tlsMode': '证书来源',
    'hint.tlsMode': 'self-signed = 自动生成自签名证书；custom = 使用自己的证书',
    'field.tlsSelfSignedHosts': '自签名证书域名/IP',
    'hint.tlsSelfSignedHosts': '逗号分隔，写入证书 SAN，如 localhost, 192.168.1.5。仅影响下次换发：已有证书沿用至到期，改动不会立刻生效',
    'field.tlsCertPath': '证书文件路径（custom）',
    'hint.tlsCertPath': 'PEM 格式证书（或证书链）的绝对路径',
    'field.tlsKeyPath': '私钥文件路径（custom）',
    'hint.tlsKeyPath': '与证书配套的 PEM 私钥绝对路径',
    'field.tlsCertMaxAgeDays': '自签名证书有效期（天）',
    'hint.tlsCertMaxAgeDays': '默认 825（约 27 个月）。仅影响下次换发：已有证书沿用至到期',
  },
  en: {
    title: 'LAN Gateway',
    description: 'Remote-access switch, port, TLS certificate, trusted CIDRs and more',
    unsaved: 'Unsaved',
    save: 'Save',
    saving: 'Saving…',
    discard: 'Discard',
    reset: 'Reset',
    readOnly: 'Gateway settings can only be changed where dsh web runs locally: the config route listens on loopback only, so a browser reaching dsh through the gateway is refused. Use the lan_gateway tool remotely.',
    saveFailed: 'The save did not land — check the inputs and retry.',
    loadFailed: 'Cannot read the gateway configuration',
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
    'field.lanPasswordless': 'LAN skip login',
    'hint.lanPasswordless': 'LAN/loopback sources skip the gateway login page but still ride one shared upstream session (needs dsh >= 0.1.2)',
    'field.allowInsecurePlaintext': 'Allow plaintext HTTP',
    'hint.allowInsecurePlaintext': 'Dangerous: start the listener even without TLS or a trusted terminator; passwords and sessions travel in clear',
    'field.trustedTerminator': 'Trusted TLS terminator',
    'hint.trustedTerminator': 'Optional identifier for a front proxy (e.g. nginx) treated as the encrypted ingress. Empty = none declared. Note: login rate limiting keys on the TCP source address, so behind a proxy every browser shares one budget (5/min)',
    'field.secureCookies': 'Session cookie Secure attribute',
    'hint.secureCookies': 'Auto = Secure when TLS or a trusted terminator is declared. Set false when the trusted proxy only authenticates over plaintext and browsers reach it over http — otherwise browsers drop the Secure cookie and every login bounces back to the login page',
    'opt.auto': 'Auto',
    'opt.true': 'Always Secure',
    'opt.false': 'No Secure (plaintext browser ingress)',
    'field.cookieMaxAgeDays': 'Session lifetime (days)',
    'hint.cookieMaxAgeDays': 'Login cookie lifetime (default 7)',
    'field.tlsEnabled': 'Enable TLS (HTTPS)',
    'hint.tlsEnabled': 'Serve the gateway over HTTPS',
    'field.tlsMode': 'Certificate source',
    'hint.tlsMode': 'self-signed = auto-generated certificate; custom = your own files',
    'field.tlsSelfSignedHosts': 'Self-signed hosts (SANs)',
    'hint.tlsSelfSignedHosts': 'Comma separated DNS/IP names, e.g. localhost, 192.168.1.5. Applies to the next issuance only: an existing certificate is reused until it expires',
    'field.tlsCertPath': 'Certificate path (custom)',
    'hint.tlsCertPath': 'Absolute path to a PEM certificate (or chain)',
    'field.tlsKeyPath': 'Private key path (custom)',
    'hint.tlsKeyPath': 'Absolute path to the matching PEM private key',
    'field.tlsCertMaxAgeDays': 'Self-signed validity (days)',
    'hint.tlsCertMaxAgeDays': 'Default 825 (about 27 months). Applies to the next issuance only: an existing certificate is reused until it expires',
  },
}

function labels(): Labels {
  const lang = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase()
  return lang.startsWith('zh') ? LABELS.zh : LABELS.en
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

  // A remote browser reaches this card through the gateway, which answers 403
  // for the plugin's own prefix by design, so the route is unreachable exactly
  // where a user is most likely to go looking for the setting. Rendering
  // nothing left them with a blank entry and no way to tell a missing card from
  // a broken one; say what is wrong and where the card does work instead.
  if (loadFailed) {
    return (
      <li style={styles.card}>
        <div style={styles.header}>
          <span style={styles.headerTop}>
            <span style={styles.name}>{t.title}</span>
          </span>
          <span style={styles.description}>{t.loadFailed}</span>
        </div>
        <div style={styles.body}>
          <p style={styles.hint}>{t.readOnly}</p>
        </div>
      </li>
    )
  }
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
      // A patch of the edited fields only, never the whole config: the card
      // cannot express every key the section may hold (a custom `cookieName`,
      // say), and posting a synthesized full config made the route treat those
      // keys as submitted — resetting each one to its schema default.
      const patch: Record<string, unknown> = {}
      for (const [field, text] of Object.entries(drafts)) {
        const def = FIELDS.find(f => f.field === field)
        if (def === undefined) continue
        const write = parseValue(def, text ?? '')
        if (write === undefined) continue
        patch[field] = write.kind === 'clear' ? null : write.value
      }
      const response = await fetch('/lan-gateway/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
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
      case 'tristate': {
        // A tri-state renders as a three-way select because neither a checkbox
        // (cannot express "unset") nor a text field (cannot express false)
        // distinguishes auto from an explicit false.
        const options = def.kind === 'tristate' ? TRISTATE_OPTIONS : (def.options ?? [])
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
              {options.map(option => (
                <option key={option} value={option}>
                  {def.kind === 'tristate' ? t[`opt.${option}`] : option}
                </option>
              ))}
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
      }
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
        <span style={styles.headerTop}>
          <span style={styles.name}>{t.title}</span>
          <span style={styles.status} title={statusLine}>{statusLine}</span>
          {dirty ? <span style={styles.pending}>{t.unsaved}</span> : null}
          <span style={open ? { ...styles.chevron, ...styles.chevronOpen } : styles.chevron}>{open ? '▾' : '▸'}</span>
        </span>
        <span style={styles.description}>{t.description}</span>
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
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: '6px',
    width: '100%',
    padding: '14px 16px',
    border: 0,
    background: 'none',
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
  },
  headerTop: { display: 'flex', alignItems: 'center', gap: '12px', width: '100%' },
  name: { flex: '1 1 auto', minWidth: 0, fontSize: '15px', fontWeight: 600, lineHeight: 1.4, color: L.labelPrimary },
  // The status carries a verbose TLS cert summary; cap it and ellipsize so it
  // can never swallow the row or squeeze the title (the old nowrap alone
  // caused the description to be pushed into a thin wrapping column).
  status: {
    flex: '0 1 auto',
    minWidth: 0,
    maxWidth: '60%',
    fontSize: '11px',
    lineHeight: 1.4,
    color: L.labelTertiary,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  description: {
    display: 'block',
    fontSize: '13px',
    lineHeight: 1.5,
    color: L.labelTertiary,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
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
