/**
 * Persistent runtime state for the LAN gateway: the cookie-signing secret and
 * the scrypt password hash. Lives in `~/.dsh/lan-gateway/state.json` (0600),
 * NOT in the schemastery Config — secrets must never surface in
 * `--dump-config` output. Writes are atomic (temp file + rename).
 *
 * @module @rice-awa/dsh-lan-gateway/state
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'

/** The state directory: `~/.dsh/lan-gateway`. */
export function stateDir(home: string = homedir()): string {
  return join(home, '.dsh', 'lan-gateway')
}

export interface PasswordRecord {
  /** Hex scrypt-derived key. */
  hash: string
  /** Hex salt. */
  salt: string
}

export interface GatewayState {
  /** Base64 cookie-signing secret (32 random bytes). */
  cookieSecret: string
  /** scrypt password record, absent when no password is set. */
  password?: PasswordRecord
}

const STATE_FILENAME = 'state.json'

/** Whether a password is present and passes scrypt verification. */
export function verifyPassword(state: GatewayState, password: string): boolean {
  if (state.password === undefined) return false
  const { hash, salt } = state.password
  try {
    const expected = Buffer.from(hash, 'hex')
    const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/** Set (or clear) the password, re-salted on every write. */
export function setPassword(state: GatewayState, password: string | undefined): GatewayState {
  if (password === undefined) {
    return { cookieSecret: state.cookieSecret }
  }
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return {
    ...state,
    password: { hash: hash.toString('hex'), salt: salt.toString('hex') },
  }
}

function defaultState(): GatewayState {
  return { cookieSecret: randomBytes(32).toString('base64') }
}

/** Load state; on first run (or a corrupt file) generate a fresh secret. */
export function loadState(home: string = homedir()): GatewayState {
  const dir = stateDir(home)
  try {
    const raw = readFileSync(join(dir, STATE_FILENAME), 'utf8')
    const parsed = JSON.parse(raw) as GatewayState
    if (typeof parsed?.cookieSecret === 'string' && parsed.cookieSecret.length >= 16) {
      return parsed
    }
    return defaultState()
  } catch {
    return defaultState()
  }
}

/** Persist state atomically. */
export function saveState(state: GatewayState, home: string = homedir()): void {
  const dir = stateDir(home)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, STATE_FILENAME)
  const tmp = join(dir, `.state.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
  renameSync(tmp, target)
  // Best-effort: keep the file private even if rename inherited a looser mode.
  try {
    chmodSync(target, 0o600)
  } catch {}
}
