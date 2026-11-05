/**
 * The lan-gateway configuration page body, rendered by the official DSH
 * Plugins page on this bundle's own page through its `plugins.bundle.config`
 * slot.
 *
 * Native first: the form is the platform's own staged settings form
 * (`SettingsFormModel` + `SettingsForm` + `SettingsValueField` /
 * `SettingsSecretField` from `@deepseek-ai/dsh-client-ui-primitives`), reading
 * and writing through `ctx.configForms.get(entryId)` — the same seam the
 * official plugin pages use, so a save is one revision-fenced document
 * mutation instead of a bespoke loopback POST, and it works from any browser
 * dsh itself admits.
 *
 * Two things are deliberately NOT settings keys and therefore keep their own
 * path: the login password (a scrypt hash in `state.json`, never in the config
 * schema or `--dump-config`) and the live listener status (a runtime fact, not
 * a document value). Both come from the plugin's loopback-only routes, so a
 * browser that is not on the host sees the fields it can edit and an explicit
 * note about the two it cannot.
 *
 * @module @riceawa/dsh-lan-gateway/client/card
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only. The Plugins page owns the `plugins.bundle.config` contract, and its
// own doc says a registrant merges that contract with `import type` instead of
// importing the package at runtime. Taking the contract from its owner is also
// what turns the next upstream rename of this slot into a compile error here,
// rather than a card that quietly stops rendering.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ConfigForms } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  Button,
  SegmentedControl,
  SettingsForm,
  SettingsFormModel,
  SettingsSecretField,
  SettingsValueField,
  Switch,
  Tag,
  type SettingsFieldSpec,
  type SettingsFieldState,
  type SettingsFormLabels,
  type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  FIELDS,
  MIN_PASSWORD_LENGTH,
  TRISTATE_OPTIONS,
  formatValue,
  parseValue,
  type FieldDef,
  type LanGatewaySettings,
  type TristateOption,
} from '../config-fields.ts'
import { LAN_GATEWAY_LOCALE, type LanGatewayKey, type LanGatewayLabels } from './locale.ts'

/**
 * The business face the registration injects: the profile entry id a settings
 * write is addressed by, and the settings service whose per-entry form the card
 * stages over. Both arrive from `apply`, so the card itself resolves nothing.
 */
export interface LanGatewayInjected {
  /** This plugin's profile entry id (`dsh-lan-gateway`). */
  entryId: string
  /** The shared per-entry configuration form service. */
  configForms: ConfigForms
}

/**
 * Props the renderer binds for this card: the page's view, the injected face,
 * and the `t` seat of the locale namespace the registration declares.
 */
export type LanGatewayCardProps =
  & PropsRuntime<'plugins.bundle.config'>
  & LanGatewayInjected
  & PropsLocale<typeof LAN_GATEWAY_LOCALE>

/**
 * The card's field table and value codecs live in `config-fields.ts`, shared
 * with the host: the host's config route decides which submitted keys are
 * editable and which empty value means "clear", and a table duplicated here
 * would let the two disagree about a field the card can render but the route
 * would refuse. Re-exported so the existing tests keep their import path.
 */
export { FIELDS, TRISTATE_OPTIONS, formatValue, parseValue }
export type { FieldDef, LanGatewaySettings }

/** GET /lan-gateway/config response (status only; the settings ride configForms). */
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

/**
 * The platform field specs, derived from the one shared field table: the same
 * codec the host route applies decides what a draft stores and what an empty
 * draft clears.
 */
export const SPECS: readonly SettingsFieldSpec[] = FIELDS.map(def => ({
  field: def.field,
  format: (value: unknown) => formatValue(def, value),
  parse: (text: string) => {
    const write = parseValue(def, text)
    return write === undefined ? undefined : write
  },
}))

/** What the card's bound projection publishes to the renderer. */
interface CardView {
  /** Form-level state: availability, writability, dirty/saving. */
  shell: SettingsFormShell
  /** One control's staged state, keyed by settings field. */
  fields: Record<string, SettingsFieldState>
}

/** The copy the platform form frame renders, in the card's own namespace. */
function formLabels(t: (key: LanGatewayKey) => string): SettingsFormLabels {
  return {
    unavailable: t('formUnavailable'),
    readOnly: t('formReadOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}

/**
 * Render the LAN gateway configuration page body.
 *
 * `summary` renders nothing: dsh asks a bundle's own configuration for its page
 * body only, and the page draws the title, icon, and crumb itself.
 * @param props - the view the Plugins page is asking for, plus the locale seat.
 * @returns the page body, or nothing while the view is `summary`.
 */
export function LanGatewayCard(props: LanGatewayCardProps): ReactNode {
  const t = props.t
  const entryId = props.entryId
  const configForms = props.configForms
  const [route, setRoute] = useState<RouteState | null>(null)
  const [offHost, setOffHost] = useState(false)
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)

  const scope = useMemo(() => configForms.get<LanGatewaySettings>(entryId), [configForms, entryId])
  // The credential is written outside the settings document, so it is not one
  // of the form's staged specs: a secret spec would create a staged control the
  // card never renders. This is the same write, kept as a plain action.
  const writePassword = useMemo(() => async (text: string): Promise<boolean> => {
    try {
      const response = await fetch('/lan-gateway/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: text }),
      })
      const body = await response.json().catch(() => null) as (Partial<RouteState> & { error?: string }) | null
      if (!response.ok) {
        setPasswordError(body?.error ?? `HTTP ${response.status}`)
        return false
      }
      if (body === null) {
        setPasswordError(t('passwordStaleHost'))
        return false
      }
      setPasswordNotice(t('passwordChanged'))
      setRoute(prev => prev === null ? prev : { ...prev, passwordSet: true })
      return true
    } catch {
      setPasswordError(t('passwordFailed'))
      return false
    }
  }, [t])

  const model = useMemo(
    () => new SettingsFormModel<LanGatewaySettings>(scope, [...SPECS]),
    [scope],
  )
  const store = useMemo(() => model.bind<CardView>(() => ({
    shell: model.shell(),
    fields: Object.fromEntries(FIELDS.map(def => [def.field, model.field(def.field)])),
  })), [model])
  // `SnapshotStore<S>` resolves through a store package the primitives declare
  // as a peer; the resolved copy here does not carry its generic through, so the
  // projection is re-asserted at the one place the card reads it.
  const view = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  ) as CardView

  useEffect(() => () => { model.dispose() }, [model])

  // The status line and the password state are runtime facts, not settings
  // values, so they keep the plugin's own loopback route. A refusal is not an
  // error here: it means the browser is not on the host, which only narrows the
  // password form (a local credential) — the settings above still work.
  useEffect(() => {
    let cancelled = false
    fetch('/lan-gateway/config')
      .then(async response => {
        if (cancelled) return
        if (!response.ok) {
          const body = await response.text().catch(() => '')
          if (!cancelled) setOffHost(refusedByGateway(response.status, body))
          return
        }
        setRoute(await response.json() as RouteState)
      })
      .catch(() => { /* status is optional; the form works without it */ })
    return () => { cancelled = true }
  }, [])

  if (props.view === 'summary') return null

  const actions = model.actions()
  const disabled = !view.shell.writable || view.shell.saving
  const badge = passwordStatus(route?.passwordSet)
  const draftProblem = passwordProblem(password, passwordConfirm)
  const passwordTyping = password !== '' || passwordConfirm !== ''
  const statusLine = route === null
    ? null
    : `${route.running ? t('running') : t('stopped')} · ${t('tls')}: ${route.tls} · :${route.port}`

  const changePassword = async (): Promise<void> => {
    if (passwordBusy || draftProblem !== null) return
    setPasswordBusy(true)
    setPasswordError(null)
    setPasswordNotice(null)
    const landed = await writePassword(password)
    if (landed) {
      setPassword('')
      setPasswordConfirm('')
    }
    setPasswordBusy(false)
  }

  return (
    <div className="lan-gw">
      {statusLine === null ? null : (
        <div className="lan-gw-status">
          <span className="lan-gw-status-text" title={statusLine}>{statusLine}</span>
          {route?.lastError ? <span className="lan-gw-status-error" role="status">{t('lastError')}: {route.lastError}</span> : null}
        </div>
      )}

      <SettingsForm
        labels={formLabels(t)}
        state={view.shell}
        onSave={() => { actions.save() }}
        onDiscard={() => { actions.discard() }}
      >
        {FIELDS.map(def => {
          const field = view.fields[def.field]!
          const common = {
            id: `lan-gw-${def.field}`,
            label: t(`field.${def.field}`),
            hint: t(`hint.${def.field}`),
            text: field.text,
            overridden: field.overridden,
            invalid: field.invalid,
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('invalid'),
            disabled,
            onEdit: (text: string) => { actions.edit(def.field, text) },
            onReset: () => { actions.resetField(def.field) },
          }
          if (def.kind === 'boolean') {
            return (
              <div className="lan-gw-row" key={def.field}>
                <div className="lan-gw-row-head">
                  <span className="lan-gw-row-label">{common.label}</span>
                  {field.overridden
                    ? <Tag tone="neutral">{t('overridden')}</Tag>
                    : null}
                  {field.overridden
                    ? (
                      <button type="button" className="lan-gw-reset" disabled={disabled} onClick={common.onReset}>
                        {t('reset')}
                      </button>
                    )
                    : null}
                </div>
                <Switch
                  checked={field.text === 'true'}
                  disabled={disabled}
                  label={common.label}
                  onChange={next => { actions.edit(def.field, next ? 'true' : 'false') }}
                />
                <p className="lan-gw-hint">{common.hint}</p>
              </div>
            )
          }
          if (def.kind === 'select' || def.kind === 'tristate') {
            const options = def.kind === 'tristate' ? TRISTATE_OPTIONS : (def.options ?? [])
            return (
              <div className="lan-gw-row" key={def.field}>
                <div className="lan-gw-row-head">
                  <span className="lan-gw-row-label" id={`${common.id}-label`}>{common.label}</span>
                  {field.overridden ? <Tag tone="neutral">{t('overridden')}</Tag> : null}
                  {field.overridden
                    ? (
                      <button type="button" className="lan-gw-reset" disabled={disabled} onClick={common.onReset}>
                        {t('reset')}
                      </button>
                    )
                    : null}
                </div>
                <SegmentedControl
                  id={common.id}
                  label={common.label}
                  value={field.text}
                  disabled={disabled}
                  options={options.map(option => ({
                    value: option,
                    // A tristate field's options are exactly TRISTATE_OPTIONS,
                    // so its copy key is closed; a select shows its value.
                    label: def.kind === 'tristate' ? t(`opt.${option as TristateOption}`) : option,
                  }))}
                  onChange={next => { actions.edit(def.field, next) }}
                />
                <p className="lan-gw-hint">{common.hint}</p>
              </div>
            )
          }
          return <SettingsValueField key={def.field} {...common} {...(def.kind === 'number' ? { numeric: true } : {})} />
        })}

        <section className="lan-gw-password" aria-labelledby="lan-gw-password-heading">
          <div className="lan-gw-row-head">
            <h3 className="lan-gw-row-label" id="lan-gw-password-heading">{t('passwordSection')}</h3>
            <Tag tone={badge === 'unset' ? 'danger' : badge === 'set' ? 'success' : 'quiet'}>
              {badge === 'set' ? t('passwordSet') : badge === 'unset' ? t('passwordUnset') : t('passwordUnknown')}
            </Tag>
          </div>
          <p className="lan-gw-hint">{t('passwordHint')}</p>
          {badge === 'unset' ? <p className="lan-gw-error">{t('passwordRequired')}</p> : null}
          {badge === 'unknown' ? <p className="lan-gw-hint">{t('passwordHostStale')}</p> : null}
          {offHost
            ? <p className="lan-gw-hint">{t('passwordOffHost')}</p>
            : (
              <>
                <SettingsSecretField
                  id="lan-gw-password"
                  label={t('passwordNew')}
                  hint={t('passwordHintShort')}
                  text={password}
                  configured={badge === 'set'}
                  stateLabel={badge === 'set' ? t('passwordSet') : t('passwordUnset')}
                  disabled={passwordBusy}
                  onEdit={(text: string) => {
                    setPassword(text)
                    setPasswordError(null)
                    setPasswordNotice(null)
                  }}
                />
                <label className="lan-gw-row-label" htmlFor="lan-gw-password-confirm">{t('passwordConfirm')}</label>
                <input
                  id="lan-gw-password-confirm"
                  className="lan-gw-input"
                  type="password"
                  autoComplete="new-password"
                  value={passwordConfirm}
                  disabled={passwordBusy}
                  onChange={event => {
                    setPasswordConfirm(event.target.value)
                    setPasswordError(null)
                    setPasswordNotice(null)
                  }}
                />
                <div className="lan-gw-password-foot">
                  {passwordError !== null
                    ? <p className="lan-gw-error" role="alert">{passwordError}</p>
                    : passwordNotice !== null
                      ? <p className="lan-gw-notice" role="status">{passwordNotice}</p>
                      : passwordTyping && draftProblem !== null
                        ? <p className="lan-gw-error" role="status">{draftProblem === 'tooShort' ? t('passwordTooShort') : t('passwordMismatch')}</p>
                        : null}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={passwordBusy || draftProblem !== null}
                    onClick={() => { void changePassword() }}
                  >
                    {passwordBusy ? t('saving') : t('passwordChange')}
                  </Button>
                </div>
              </>
            )}
        </section>
      </SettingsForm>
    </div>
  )
}

/** The locale namespace this card's copy registers under. */
export const LOCALE_NAMESPACE = LAN_GATEWAY_LOCALE
