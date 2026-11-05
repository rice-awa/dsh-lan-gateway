/**
 * The card's bilingual copy, registered into the dsh locale registry as one
 * namespace.
 *
 * Registering here instead of picking a language from `navigator.language` is
 * what makes the card follow the Settings → Language switch like every official
 * surface: `ctx.locale.register` hands the renderer a `t` seat whose identity
 * moves with the active locale, so a switch re-renders the card in place.
 *
 * @module @riceawa/dsh-lan-gateway/client/locale
 */

import type { ConfigFieldKey, TristateOption } from '../config-fields.ts'

/** The locale namespace this bundle owns. */
export const LAN_GATEWAY_LOCALE = 'dshLanGateway'

/**
 * Every key the card renders, as a closed union: the fixed labels below plus
 * one `field.*` / `hint.*` key per shared config field and one `opt.*` key per
 * tri-state option. Spelling it as a union (rather than index signatures) is
 * what makes a mistyped key in the card — or a key missing from either
 * dictionary — a compile error instead of a rendered key string.
 */
export type LanGatewayKey =
  | keyof LanGatewayLabelsBase
  | `field.${ConfigFieldKey}`
  | `hint.${ConfigFieldKey}`
  | `opt.${TristateOption}`

/** The dictionary both languages must spell in full. */
export type LanGatewayLabels = Record<LanGatewayKey, string>

/** The fixed labels, i.e. everything not derived from the field table. */
export interface LanGatewayLabelsBase {
  save: string
  saving: string
  discard: string
  reset: string
  overridden: string
  invalid: string
  saveFailed: string
  formUnavailable: string
  formReadOnly: string
  running: string
  stopped: string
  tls: string
  lastError: string
  passwordSection: string
  passwordHint: string
  passwordHintShort: string
  passwordNew: string
  passwordConfirm: string
  passwordSet: string
  passwordUnset: string
  passwordUnknown: string
  passwordRequired: string
  passwordHostStale: string
  passwordOffHost: string
  passwordChange: string
  passwordChanged: string
  passwordFailed: string
  passwordStaleHost: string
  passwordTooShort: string
  passwordMismatch: string
}

/** The Chinese copy. */
export const ZH: LanGatewayLabels = {
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  reset: '重置',
  overridden: '已覆盖',
  invalid: '格式不对',
  saveFailed: '保存未生效，请检查输入后重试。',
  formUnavailable: '宿主端没有提供本插件的配置：请确认 profile 里有 dsh-lan-gateway 这一条。',
  formReadOnly: '当前 profile 的配置是只读的，改动不会保存。',
  running: '运行中',
  stopped: '已停止',
  tls: 'TLS',
  lastError: '上次错误',
  passwordSection: '登录密码',
  passwordHint: '当前密码不会显示（也读不出来）。输入两次新密码后直接覆盖原密码；改密会递增会话代次，所有已登录会话与已建立的 WebSocket 立即失效。',
  passwordHintShort: '至少 8 位。留空则不修改。',
  passwordNew: '新密码',
  passwordConfirm: '再次输入新密码',
  passwordSet: '已设置',
  passwordUnset: '未设置',
  passwordUnknown: '状态未知（宿主端较旧）',
  passwordRequired: '未设置密码时网关拒绝启动。',
  passwordHostStale: '宿主端没有报告密码状态，说明 dsh web 还在运行旧版本：重启后这里才会显示「已设置 / 未设置」。',
  passwordOffHost: '改密只在宿主机上可用：这个接口只应答回环同源请求。请在本机用 127.0.0.1 或 localhost 打开本页，或远程改用 lan_gateway 工具的 set-password。',
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
}

/** The English copy. */
export const EN: LanGatewayLabels = {
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  reset: 'Reset',
  overridden: 'Overridden',
  invalid: 'Invalid',
  saveFailed: 'The save did not land — check the inputs and retry.',
  formUnavailable: 'The host does not serve this plugin’s configuration: check that the profile composes dsh-lan-gateway.',
  formReadOnly: 'This profile’s configuration is read-only; edits will not be saved.',
  running: 'Running',
  stopped: 'Stopped',
  tls: 'TLS',
  lastError: 'Last error',
  passwordSection: 'Login password',
  passwordHint: 'The current password is never shown (it cannot be read back). Enter a new one twice to overwrite it; changing it advances the session epoch, so every signed-in session and live WebSocket is invalidated at once.',
  passwordHintShort: 'At least 8 characters. Leave blank to keep the current one.',
  passwordNew: 'New password',
  passwordConfirm: 'Repeat new password',
  passwordSet: 'Set',
  passwordUnset: 'Not set',
  passwordUnknown: 'Unknown (older host)',
  passwordRequired: 'The gateway refuses to start without a password.',
  passwordHostStale: 'The host did not report a password state, so dsh web is still running the previous build: restart it to get Set / Not set here.',
  passwordOffHost: 'The password can only be changed on the host: this route answers same-origin loopback requests only. Open this page on the host via 127.0.0.1 or localhost, or use the lan_gateway tool’s set-password remotely.',
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
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** LAN gateway configuration page copy. */
    dshLanGateway: LanGatewayKey
  }
}
