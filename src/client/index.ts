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
// Type-only: the `locale` and `settingsScope` Context merges live in these
// packages; nothing of them is imported at runtime.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { LanGatewayCard, type LanGatewaySettings } from './lan-gateway-card.tsx'

export const name = 'dsh-lan-gateway'

/** Settings namespace + card slot. */
const SETTINGS_NS = 'lan-gateway'
const LOCALE_NS = 'lan-gateway-settings'

/** Dictionary namespace owned by this card (untyped form — external NS). */
const zhDict: Record<string, string> = {
  title: 'LAN 网关',
  description: '远程访问开关与端口、TLS 证书、受信网段等网关设置',
  unsaved: '未保存',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  reset: '重置',
  overridden: '已覆盖',
  readOnly: '此部署的网关设置只读（远程浏览器）。',
  saveFailed: '保存未生效，请检查输入后重试。',
  emptyMeansClear: '留空 = 使用默认',
  'field.enabled': '启用网关',
  'hint.enabled': '开机时监听 0.0.0.0 网关端口',
  'field.gatewayPort': '网关端口',
  'hint.gatewayPort': '绑定到 0.0.0.0 的监听端口（默认 3081）',
  'field.dshTargetPort': 'dsh 目标端口',
  'hint.dshTargetPort': '留空则自动跟随 dsh web 端口（默认 3080）',
  'field.lanCidrs': '免密 LAN 网段',
  'hint.lanCidrs': '逗号分隔的 CIDR，如 10.0.0.0/8, 192.168.0.0/16',
  'field.authRequired': '非 LAN 访问需要密码',
  'hint.authRequired': '公网来源必须登录后才能访问',
  'field.cookieMaxAgeDays': '会话有效期（天）',
  'hint.cookieMaxAgeDays': '登录 cookie 的存活天数（默认 30）',
  'field.tlsEnabled': '启用 TLS（HTTPS）',
  'hint.tlsEnabled': '以 HTTPS 提供网关服务，浏览器不再提示不安全',
  'field.tlsMode': '证书来源',
  'hint.tlsMode': 'self-signed = 自动生成自签名证书；custom = 使用自己的证书',
  'field.tlsSelfSignedHosts': '自签名证书域名/IP',
  'hint.tlsSelfSignedHosts': '逗号分隔，写入证书 SAN，如 localhost, 192.168.1.5',
  'field.tlsCertPath': '证书文件路径（custom）',
  'hint.tlsCertPath': 'PEM 格式证书（或证书链）的绝对路径',
  'field.tlsKeyPath': '私钥文件路径（custom）',
  'hint.tlsKeyPath': '与证书配套的 PEM 私钥绝对路径',
}

const enDict: Record<string, string> = {
  title: 'LAN Gateway',
  description: 'Remote-access switch, port, TLS certificate, trusted CIDRs and more',
  unsaved: 'Unsaved',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  reset: 'Reset',
  overridden: 'overridden',
  readOnly: 'Gateway settings are read-only for this deployment (remote browser).',
  saveFailed: 'The save did not land as staged — check the inputs and retry.',
  emptyMeansClear: 'Empty = default',
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
  'hint.cookieMaxAgeDays': 'Login cookie lifetime (default 30)',
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
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Mount the settings card and the UUID shim.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  installRandomUuidShim()

  const t = ctx.locale.bind(LOCALE_NS)
  ctx.effect(() => {
    const disposers = [
      ctx.locale.register(LOCALE_NS, 'zh', zhDict),
      ctx.locale.register(LOCALE_NS, 'en', enDict),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'lan-gateway: card dictionaries')

  const scope = ctx.settingsScope.bind<LanGatewaySettings>({ namespace: SETTINGS_NS })

  // The card rides the official Plugins → Configurable tab.
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'lan-gateway',
    order: 30,
    inject: () => ({ scope, t }),
  }, LanGatewayCard))
}
