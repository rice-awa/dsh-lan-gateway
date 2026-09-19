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
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
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
  /**
   * Revoked session ids, each mapped to the epoch millis at which that
   * session's own cookie expires. Signing out revokes the single id the
   * browser presented, so the account's other sessions keep working, and it
   * has to be persisted: the cookie it names stays unforgeable until it
   * expires, and a restart must not resurrect it. Entries lapse once the
   * cookie they name could no longer be presented anyway, which bounds the
   * list by the sessions that are still live somewhere. Absent on state
   * written before 0.5.4.
   */
  revokedSessions?: Record<string, number>
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
 *
 * Deriving the key is asynchronous for the same reason
 * {@link verifyPassword} is: `scryptSync` occupies the event loop for tens of
 * milliseconds, and that loop is shared with the dsh process the gateway
 * forwards to. Every caller is already async.
 */
export async function setPassword(state: GatewayState, password: string | undefined): Promise<GatewayState> {
  // The new epoch invalidates every cookie on its own account, so the list of
  // individually revoked sessions has nothing left to say: drop it rather than
  // carry entries that can never match again.
  const base: GatewayState = {
    cookieSecret: state.cookieSecret,
    sessionEpoch: state.sessionEpoch + 1,
  }
  if (password === undefined) return base
  const salt = randomBytes(16)
  const hash = await deriveKey(password, salt, 64)
  return {
    ...base,
    password: { hash: hash.toString('hex'), salt: salt.toString('hex') },
  }
}

/**
 * Record a session id as revoked.
 * @param expiresMs - the revoked cookie's own expiry. Past it the cookie is
 *   rejected on its own account, so the entry is no longer needed; dropping
 *   expired entries here is what keeps the list bounded.
 * @param now - epoch millis to judge the existing entries against, injected so
 *   a test can age the list without fake timers.
 */
export function revokeSession(
  state: GatewayState,
  sid: string,
  expiresMs: number,
  now: number = Date.now(),
): GatewayState {
  const revoked: Record<string, number> = {}
  for (const [id, exp] of Object.entries(state.revokedSessions ?? {})) {
    if (exp > now) revoked[id] = exp
  }
  revoked[sid] = expiresMs
  return { ...state, revokedSessions: revoked }
}

/** Whether `sid` names a session that has been signed out. */
export function isSessionRevoked(state: GatewayState, sid: string | undefined): boolean {
  if (sid === undefined) return false
  return Object.hasOwn(state.revokedSessions ?? {}, sid)
}

function defaultState(): GatewayState {
  return { cookieSecret: randomBytes(32).toString('base64'), sessionEpoch: 0 }
}

/** Keep the still-live entries of a persisted revocation list, or undefined. */
function parseRevokedSessions(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const now = Date.now()
  const out: Record<string, number> = {}
  let anyLive = false
  for (const [sid, exp] of Object.entries(raw)) {
    if (typeof exp === 'number' && Number.isFinite(exp) && exp > now) {
      out[sid] = exp
      anyLive = true
    }
  }
  return anyLive ? out : undefined
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
      // Anything the file lists past its own expiry has lapsed on its own.
      const revoked = parseRevokedSessions(parsed.revokedSessions)
      if (revoked !== undefined) base.revokedSessions = revoked
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
