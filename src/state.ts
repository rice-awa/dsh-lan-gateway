/**
 * Persistent runtime state for the LAN gateway: the cookie-signing secret and
 * the scrypt password hash. Lives in `~/.dsh/lan-gateway/state.json` (0600),
 * NOT in the schemastery Config — secrets must never surface in
 * `--dump-config` output. Writes are atomic (temp file + rename).
 *
 * @module @riceawa/dsh-lan-gateway/state
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
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
  /**
   * Session revocation epoch. Every issued login cookie carries the epoch it
   * was signed under; a cookie whose epoch differs from the current one is
   * rejected. Setting or clearing the password (and rotating the signing
   * secret) increments the epoch so every previously issued session dies
   * immediately. Old state files without the field load as epoch 0.
   */
  sessionEpoch: number
}

const STATE_FILENAME = 'state.json'

/** Promise wrapper around the threaded `scrypt`, which runs off the main loop. */
function deriveKey(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (error, derived) => {
      if (error !== null) reject(error)
      else resolve(derived)
    })
  })
}

/**
 * Whether a password is present and passes scrypt verification. Asynchronous
 * on purpose: `scryptSync` occupies the event loop for tens of milliseconds
 * per attempt, and that loop is shared with the dsh process the gateway is
 * forwarding to.
 */
export async function verifyPassword(state: GatewayState, password: string): Promise<boolean> {
  if (state.password === undefined) return false
  const { hash, salt } = state.password
  try {
    const expected = Buffer.from(hash, 'hex')
    const actual = await deriveKey(password, Buffer.from(salt, 'hex'), expected.length)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/**
 * Set (or clear) the password, re-salted on every write. Both operations bump
 * the session epoch so every cookie issued under the previous epoch dies — a
 * password change must invalidate sessions the old password authorized.
 */
export function setPassword(state: GatewayState, password: string | undefined): GatewayState {
  const base = { ...state, sessionEpoch: state.sessionEpoch + 1 }
  if (password === undefined) {
    return { cookieSecret: base.cookieSecret, sessionEpoch: base.sessionEpoch }
  }
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return {
    ...base,
    password: { hash: hash.toString('hex'), salt: salt.toString('hex') },
  }
}

function defaultState(): GatewayState {
  return { cookieSecret: randomBytes(32).toString('base64'), sessionEpoch: 0 }
}

/** Load state; on first run (or a corrupt file) generate a fresh secret. */
export function loadState(home: string = homedir()): GatewayState {
  const dir = stateDir(home)
  try {
    const raw = readFileSync(join(dir, STATE_FILENAME), 'utf8')
    const parsed = JSON.parse(raw) as Partial<GatewayState>
    if (typeof parsed?.cookieSecret === 'string' && parsed.cookieSecret.length >= 16) {
      // Pre-0.5.0 files carry no sessionEpoch: treat them as epoch 0 so any
      // cookie they issued (also epoch-less) still validates until the next
      // password change or secret rotation bumps the epoch.
      const sessionEpoch = typeof parsed.sessionEpoch === 'number' && Number.isSafeInteger(parsed.sessionEpoch)
        ? parsed.sessionEpoch
        : 0
      const base: GatewayState = { cookieSecret: parsed.cookieSecret, sessionEpoch }
      if (parsed.password !== undefined) base.password = parsed.password
      return base
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
