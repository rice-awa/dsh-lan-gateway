/**
 * The lan-gateway configuration card, rendered by the official DSH Plugins page
 * on this bundle's own page through its `plugins.bundle.config` slot.
 *
 * ModLens-style: the card carries NO injected services. It reads and writes
 * the loopback-only `/lan-gateway/config` host route (the browser never sees
 * the settings seam or any secret), so the only platform service it needs is
 * the `slots` service every plugin already has.
 *
 * The page — not the card — draws the plugin's title, icon, and crumb, and the
 * card is the page body: `view: 'summary'` renders nothing (bundle
 * configuration is `page`-only).
 *
 * @module @riceawa/dsh-lan-gateway/client/card
 */

import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only. The Plugins page owns the `plugins.bundle.config` contract, and its
// own doc says a registrant merges that contract with `import type` instead of
// importing the package at runtime. Taking the contract from its owner is also
// what turns the next upstream rename of this slot into a compile error here,
// rather than a card that quietly stops rendering.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  FIELDS,
  MIN_PASSWORD_LENGTH,
  TRISTATE_OPTIONS,
  formatValue,
  parseValue,
  type FieldDef,
  type LanGatewaySettings,
} from '../config-fields.ts'

/**
 * Props the renderer binds for this card. The Plugins page asks a bundle's
 * configuration entry only for the body of its own page (`page`); the shared
 * contract still carries `summary`, which bundle configuration never renders.
 * The card needs no injected face — it fetches its own route.
 */
export type LanGatewayCardProps = PropsRuntime<'plugins.bundle.config'>

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
  /** Whether a login credential exists. Never the credential itself. */
  passwordSet?: boolean
}

/** Why a password draft cannot be submitted yet. */
export type PasswordProblem = 'tooShort' | 'mismatch'

/**
 * The card's password badge state.
 *
 * Three states, not two: a host that predates the password route does not
 * report `passwordSet` at all, and `undefined` must read as "unknown" rather
 * than "not set" — a client refreshed against a running old host would
 * otherwise announce that a gateway which is demonstrably running (it cannot
 * start without a credential) has no password.
 */
export type PasswordStatus = 'set' | 'unset' | 'unknown'

/**
 * Classify the host's `passwordSet` for the badge.
 * @param passwordSet - the snapshot's flag, or `undefined` when absent.
 * @returns `set` / `unset` / `unknown` (absent field).
 */
export function passwordStatus(passwordSet: boolean | undefined): PasswordStatus {
  if (passwordSet === undefined) return 'unknown'
  return passwordSet ? 'set' : 'unset'
}

/**
 * Judge a password draft the way the host's password route will, so a draft the
 * card enables is never answered with a 400. The length bound is the shared
 * {@link MIN_PASSWORD_LENGTH}; the confirmation is a UI concern and is checked
 * here rather than server-side (the host is told one password, and storing only
 * what was typed twice is the browser's job).
 * @param password - the new password draft.
 * @param confirm - the confirmation draft.
 * @returns the reason it cannot be submitted, or `null` when it can.
 */
export function passwordProblem(password: string, confirm: string): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'tooShort'
  if (password !== confirm) return 'mismatch'
  return null
}

/**
 * Whether the config route's refusal came from the gateway rather than from dsh
 * itself.
 *
 * The gateway owns the `/lan-gateway*` prefix and answers it with a bare 403
 * `forbidden` whenever the client is not on the host; dsh, when it answers the
 * route at all, does not produce that pair. Telling the two apart is what lets
 * the card say "you are not on the host loopback" instead of the generic
 * "cannot read the configuration".
 * @param status - the HTTP status of the failed read.
 * @param body - that response's body.
 * @returns true when the gateway itself refused the read.
 */
export function refusedByGateway(status: number, body: string): boolean {
  return status === 403 && body.trim() === 'forbidden'
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
  readOnlyGateway: string
  saveFailed: string
  loadFailed: string
  emptyMeansClear: string
  running: string
  stopped: string
  tls: string
  lastError: string
  passwordSection: string
  passwordHint: string
  passwordNew: string
  passwordConfirm: string
  passwordSet: string
  passwordUnset: string
  passwordUnknown: string
  passwordRequired: string
  passwordHostStale: string
  passwordChange: string
  passwordChanged: string
  passwordFailed: string
  passwordStaleHost: string
  passwordTooShort: string
  passwordMismatch: string
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
    readOnly: '读不到网关配置：这个接口只在宿主机本机应答——Host 必须是回环地址且同源。请在宿主机上打开 dsh web 时修改，远程请改用 lan_gateway 工具。',
    readOnlyGateway: '网关拒绝了这次读取：/lan-gateway/* 管理面由网关独占，只放行「TCP 来源为回环 且 地址写的是 127.0.0.1 / localhost」的浏览器。你现在不是从宿主机回环地址访问的——请在宿主机上用 127.0.0.1 或 localhost 打开本页（局域网 IP、域名都不算），或远程改用 lan_gateway 工具。',
    saveFailed: '保存未生效，请检查输入后重试。',
    loadFailed: '无法读取网关配置',
    emptyMeansClear: '留空 = 使用默认',
    running: '运行中',
    stopped: '已停止',
    tls: 'TLS',
    lastError: '上次错误',
    passwordSection: '登录密码',
    passwordHint: '当前密码不会显示（也读不出来）。输入两次新密码后直接覆盖原密码；改密会递增会话代次，所有已登录会话与已建立的 WebSocket 立即失效。仅在从本机 loopback 打开 dsh web 时可改。',
    passwordNew: '新密码（至少 8 位）',
    passwordConfirm: '再次输入新密码',
    passwordSet: '已设置',
    passwordUnset: '未设置',
    passwordUnknown: '状态未知（宿主端较旧）',
    passwordRequired: '未设置密码时网关拒绝启动。',
    passwordHostStale: '宿主端没有报告密码状态，说明 dsh web 还在运行旧版本：重启后这里才会显示「已设置 / 未设置」，这个改密表单也才会生效。',
    passwordChange: '修改密码',
    passwordChanged: '密码已更新：旧密码立即失效，所有已登录会话已作废。',
    passwordFailed: '修改密码失败，请重试。',
    passwordStaleHost: '宿主端没有响应这个接口：可能还没重启 dsh web 加载新版本。重启后再试；重启前仍可用 lan_gateway 工具改密。',
    passwordTooShort: '密码至少 8 位。',
    passwordMismatch: '两次输入不一致。',
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
    readOnly: 'Cannot read the configuration: the route answers on the host only — the Host must be a loopback address and same-origin. Change the settings where dsh web runs on the host, or use the lan_gateway tool remotely.',
    readOnlyGateway: 'The gateway refused this read: it owns the /lan-gateway/* management plane and admits only browsers that are both loopback-sourced and using a 127.0.0.1 / localhost address. You are not on the host loopback — open this page on the host via 127.0.0.1 or localhost (a LAN IP or a hostname does not qualify), or use the lan_gateway tool remotely.',
    saveFailed: 'The save did not land — check the inputs and retry.',
    loadFailed: 'Cannot read the gateway configuration',
    emptyMeansClear: 'Empty = default',
    running: 'Running',
    stopped: 'Stopped',
    tls: 'TLS',
    lastError: 'Last error',
    passwordSection: 'Login password',
    passwordHint: 'The current password is never shown (it cannot be read back). Enter a new one twice to overwrite it; changing it advances the session epoch, so every signed-in session and live WebSocket is invalidated at once. Only changeable where dsh web runs on loopback.',
    passwordNew: 'New password (min 8 chars)',
    passwordConfirm: 'Repeat new password',
    passwordSet: 'Set',
    passwordUnset: 'Not set',
    passwordUnknown: 'Unknown (older host)',
    passwordRequired: 'The gateway refuses to start without a password.',
    passwordHostStale: 'The host did not report a password state, so dsh web is still running the previous build: restart it to get Set / Not set here and to make this form take effect.',
    passwordChange: 'Change password',
    passwordChanged: 'Password updated: the old one no longer works and every signed-in session was revoked.',
    passwordFailed: 'The password change failed — retry.',
    passwordStaleHost: 'The host did not answer this endpoint — it may still be running the previous build. Restart dsh web and retry; the lan_gateway tool can change the password meanwhile.',
    passwordTooShort: 'At least 8 characters.',
    passwordMismatch: 'The two entries do not match.',
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
 * Render the LAN gateway configuration card. Self-loading: fetches the config
 * route on mount, posts the edited config on save.
 *
 * `summary` renders nothing: dsh asks a bundle's own configuration for its page
 * body only, and the card's former one-liner (a list entry on the official
 * plugin card) went away with `plugins.item`.
 * @param props - the view the Plugins page is asking for.
 * @returns the page body, or nothing while the view is `summary`.
 */
export function LanGatewayCard(props: LanGatewayCardProps): ReactNode {
  const t = labels()
  const [route, setRoute] = useState<RouteState | null>(null)
  const [failure, setFailure] = useState<'gateway' | 'other' | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<string, string>>>({})
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // The password section is its own submit path: a password is not a settings
  // key, so it must not ride the config patch (nor light up the card's "未保存"
  // badge for every keystroke in a password box).
  const [password, setPasswordDraft] = useState('')
  const [passwordConfirm, setPasswordConfirmDraft] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/lan-gateway/config')
      .then(async (response) => {
        if (cancelled) return
        if (!response.ok) {
          // The body is only read to tell the gateway's own bare refusal from
          // any other answer; it is never rendered.
          const body = await response.text().catch(() => '')
          if (!cancelled) setFailure(refusedByGateway(response.status, body) ? 'gateway' : 'other')
          return
        }
        setRoute(await response.json() as RouteState)
      })
      .catch(() => {
        if (!cancelled) setFailure('other')
      })
    return () => { cancelled = true }
  }, [])

  // dsh asks a bundle for its own configuration under `view: 'page'` only, and
  // the page draws the title, icon, and crumb itself — so the card is the page
  // body and has no one-liner. Returning null keeps the contribution honest for
  // a host that ever asks for the other view.
  if (props.view === 'summary') return null

  // A browser that is not on the host reaches this card through the gateway,
  // which answers 403 for the plugin's own prefix by design, so the route is
  // unreachable exactly where a user is most likely to go looking for the
  // setting. Rendering nothing left them with a blank entry and no way to tell a
  // missing card from a broken one; say what is wrong — and whether the gateway
  // or the host refused — and where the card does work instead.
  if (failure !== null) {
    return (
      <div style={styles.card}>
        <p style={styles.status}>{t.loadFailed}</p>
        <p style={styles.hint}>{failure === 'gateway' ? t.readOnlyGateway : t.readOnly}</p>
      </div>
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
  const passwordDraftProblem = passwordProblem(password, passwordConfirm)
  const passwordTyping = password !== '' || passwordConfirm !== ''
  const passwordBadge = passwordStatus(route.passwordSet)

  /** Adopt the host's post-write snapshot, keeping the last known values. */
  const adopt = (body: Partial<RouteState>): void => {
    if (body.config === undefined) return
    setRoute({
      config: body.config,
      running: body.running ?? false,
      port: body.port ?? 0,
      tls: body.tls ?? '',
      lastError: body.lastError ?? null,
      // Absent is a state of its own (an older host does not report the field),
      // so it must not be coerced into `false`: that is what made a running,
      // password-protected gateway render as "not set".
      ...(body.passwordSet !== undefined ? { passwordSet: body.passwordSet } : {}),
    })
  }

  /**
   * Overwrite the login password. Deliberately writes only to
   * `/lan-gateway/password`: the credential is not part of the config patch, so
   * a change here can never disturb an unsaved settings draft, and the old
   * password is neither sent nor requested.
   */
  const changePassword = async (): Promise<void> => {
    if (passwordBusy || passwordProblem(password, passwordConfirm) !== null) return
    setPasswordBusy(true)
    setPasswordError(null)
    setPasswordNotice(null)
    try {
      const response = await fetch('/lan-gateway/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      // A host that predates this route answers the SPA fallback (HTML, 200),
      // not a 404 — so "not our JSON" is the signal, and it must not read as a
      // wrong password or a network failure.
      const body = await response.json().catch(() => null) as (Partial<RouteState> & { error?: string }) | null
      if (!response.ok) {
        setPasswordError(body?.error ?? (response.status === 404 ? t.passwordStaleHost : `HTTP ${response.status}`))
        return
      }
      if (body === null) {
        setPasswordError(t.passwordStaleHost)
        return
      }
      // Clear the boxes the moment the write lands: the new credential is now
      // the stored one, and leaving it on screen is the one thing a password
      // field should not do.
      setPasswordDraft('')
      setPasswordConfirmDraft('')
      setPasswordNotice(t.passwordChanged)
      adopt(body)
    } catch {
      setPasswordError(t.passwordFailed)
    } finally {
      setPasswordBusy(false)
    }
  }

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
      adopt(body)
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
    <div style={styles.card}>
      {/* The page above draws the plugin's title itself, so the card opens with
          the live listener status and the unsaved marker — the two facts an
          operator wants before touching a field. */}
      <div style={styles.statusRow}>
        <span style={styles.status} title={statusLine}>{statusLine}</span>
        {dirty ? <span style={styles.pending}>{t.unsaved}</span> : null}
      </div>
      <div style={styles.body}>
        {route.lastError ? <p style={styles.error} role="status">{t.lastError}: {route.lastError}</p> : null}
        <div style={styles.section}>
          <div style={styles.sectionHead}>
            <span style={styles.label}>{t.passwordSection}</span>
            <span style={passwordBadge === 'unset' ? styles.badgeAlert : styles.badge}>
              {passwordBadge === 'set'
                ? t.passwordSet
                : passwordBadge === 'unset' ? t.passwordUnset : t.passwordUnknown}
            </span>
          </div>
          <p style={styles.hint}>{t.passwordHint}</p>
          {passwordBadge === 'unset' ? <p style={styles.error}>{t.passwordRequired}</p> : null}
          {passwordBadge === 'unknown' ? <p style={styles.hint}>{t.passwordHostStale}</p> : null}
          <div style={styles.passwordRow}>
            <input
              id="lan-gw-password"
              type="password"
              autoComplete="new-password"
              aria-label={t.passwordNew}
              style={passwordInput}
              placeholder={t.passwordNew}
              value={password}
              disabled={passwordBusy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setPasswordDraft(e.target.value)
                setPasswordError(null)
                setPasswordNotice(null)
              }}
            />
            <input
              id="lan-gw-password-confirm"
              type="password"
              autoComplete="new-password"
              aria-label={t.passwordConfirm}
              style={passwordInput}
              placeholder={t.passwordConfirm}
              value={passwordConfirm}
              disabled={passwordBusy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setPasswordConfirmDraft(e.target.value)
                setPasswordError(null)
                setPasswordNotice(null)
              }}
            />
          </div>
          <div style={styles.passwordFoot}>
            {passwordError !== null
              ? <p style={styles.error} role="alert">{passwordError}</p>
              : passwordNotice !== null
                ? <p style={styles.notice} role="status">{passwordNotice}</p>
                : passwordTyping && passwordDraftProblem !== null
                  ? (
                    <p style={styles.error} role="status">
                      {passwordDraftProblem === 'tooShort' ? t.passwordTooShort : t.passwordMismatch}
                    </p>
                  )
                  : null}
            <button
              type="button"
              style={styles.save}
              disabled={passwordBusy || passwordDraftProblem !== null}
              onClick={() => { void changePassword() }}
            >
              {passwordBusy ? t.saving : t.passwordChange}
            </button>
          </div>
        </div>
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
    </div>
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
  labelPrimary: tk('--dsw-alias-label-primary', 'inherit'),
  labelSecondary: tk('--dsw-alias-label-secondary', 'inherit'),
  labelTertiary: tk('--dsw-alias-label-tertiary', 'rgba(127,127,127,0.8)'),
  error: tk('--dsw-alias-label-error', '#d1242f'),
  badgeBg: tk('--dsw-alias-bg-module-platform', 'rgba(127,127,127,0.14)'),
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    listStyle: 'none',
    border: `1px solid ${L.border}`,
    borderRadius: '12px',
    background: L.bg,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  // The page draws the plugin's title above this body, so the card leads with
  // the live listener status and the unsaved marker instead.
  statusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '12px 16px',
    borderBottom: `1px solid ${L.border}`,
  },
  // The status carries a verbose TLS cert summary; cap it and ellipsize so it
  // can never swallow the row.
  status: {
    flex: '0 1 auto',
    minWidth: 0,
    maxWidth: '80%',
    fontSize: '11px',
    lineHeight: 1.4,
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
  body: {
    padding: '4px 16px 8px',
    display: 'flex',
    flexDirection: 'column',
  },
  // The password block sits inside the card body, ahead of the config fields:
  // it is the setting an operator comes here for, and it owns its own submit
  // button (a password is not part of the settings patch), so it is separated
  // by a rule rather than merged into the field list.
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '14px 0',
    borderBottom: `1px solid ${L.border}`,
  },
  sectionHead: { display: 'flex', alignItems: 'center', gap: '8px' },
  badge: {
    borderRadius: '999px',
    padding: '1px 8px',
    fontSize: '11px',
    lineHeight: '17px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    background: L.badgeBg,
    color: L.labelSecondary,
  },
  badgeAlert: {
    borderRadius: '999px',
    padding: '1px 8px',
    fontSize: '11px',
    lineHeight: '17px',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    background: L.badgeBg,
    color: L.error,
  },
  notice: { flex: 1, minWidth: 0, margin: 0, fontSize: '12px', lineHeight: 1.5, color: L.labelSecondary },
  passwordRow: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  passwordFoot: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
    marginTop: '2px',
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

/** The shared input style plus the growth two side-by-side password boxes need. */
const passwordInput: React.CSSProperties = { ...styles.input, flex: '1 1 160px' }
