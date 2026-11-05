/**
 * The card's own layout CSS.
 *
 * Only layout the platform does not own lives here: the status strip, the row
 * wrapper that adds a hairline between fields, and the password block. Every
 * control, label, hint, badge, and save button is the platform's
 * (`SettingsForm` / `SettingsValueField` / `Switch` / `SegmentedControl`), so
 * its colors, radii, focus rings, and dark-mode tokens stay the platform's.
 *
 * Inserted once per page, keyed by the package name, and removed with the
 * plugin tree — a module-scope `document.head.appendChild` would survive an
 * HMR reload and stack duplicate sheets.
 *
 * @module @riceawa/dsh-lan-gateway/client/styles
 */

const STYLE_ID = 'dsh-lan-gateway-styles'

const CSS = `
.lan-gw {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.lan-gw-status {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 12px;
  padding-bottom: 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

.lan-gw-status-text {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}

.lan-gw-status-error {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
}

.lan-gw-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
}

.lan-gw-row + .lan-gw-row {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

.lan-gw-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.lan-gw-row-label {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}

.lan-gw-reset {
  flex: none;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}

.lan-gw-reset:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}

.lan-gw-reset:disabled {
  cursor: default;
}

.lan-gw-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}

.lan-gw-error {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary);
}

.lan-gw-notice {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}

.lan-gw-password {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px 0 4px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}

.lan-gw-password-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.lan-gw-input {
  height: 34px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}

.lan-gw-input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}

.lan-gw-input:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
`

/**
 * Insert the card's stylesheet once per page.
 * @returns the disposer removing it (idempotent).
 */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) {
    return () => { existing.remove() }
  }
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
