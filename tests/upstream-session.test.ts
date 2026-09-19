/**
 * Unit tests for the shared upstream-session relay against a real loopback
 * HTTP server — the half of the seam the integration suite stubs out with a
 * fake session object. The regression this pins: upstream names its
 * browser-session cookie `dsh-auth-<base64url(sha256(authority))>`, so a
 * matcher looking for `dsh-auth-=` finds nothing, the relay holds no session,
 * and every forwarded request reaches upstream anonymously (401).
 *
 * @module tests/upstream-session
 */

import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { UpstreamSessionRelay } from '../src/upstream-session.ts'

/** How the fake index route answers a token exchange. */
type Outcome = 'mint' | 'refuse' | 'other'

interface FakeUpstream {
  port: number
  authority: string
  /** Requests the upstream observed, in order. */
  seen: { url: string | undefined; host: string | undefined }[]
  /** The cookie value minted from now on (so a test can rotate it). */
  value: string
  /** What the token exchange answers from now on. */
  outcome: Outcome
  close: () => Promise<void>
}

/**
 * A loopback stand-in for dsh's launch-token index route: it mints the real
 * cookie name for whatever authority the request names, exactly as
 * `BrowserAuth.authorizeIndex` does.
 */
async function fakeUpstream(options: { outcome?: Outcome; value?: string; maxAge?: number } = {}): Promise<FakeUpstream> {
  const observed: FakeUpstream['seen'] = []
  let outcome: Outcome = options.outcome ?? 'mint'
  let value = options.value ?? 'v1.payload.sig'
  // A short Max-Age puts the relay inside its 60s pre-expiry refresh window,
  // so the next cookie() re-acquires instead of serving the cached value.
  const maxAge = options.maxAge ?? 604800
  const server = http.createServer((req, res) => {
    observed.push({ url: req.url, host: req.headers.host })
    if (outcome === 'refuse') {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
      return
    }
    if (outcome === 'other') {
      res.writeHead(303, { location: '/', 'set-cookie': ['unrelated=1; Path=/'] })
      res.end()
      return
    }
    const authority = String(req.headers.host)
    const name = `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
    res.writeHead(303, {
      location: '/',
      'set-cookie': [`${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict`],
    })
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const fake: FakeUpstream = {
    port,
    authority: `127.0.0.1:${port}`,
    seen: observed,
    get value() {
      return value
    },
    set value(next: string) {
      value = next
    },
    get outcome() {
      return outcome
    },
    set outcome(next: Outcome) {
      outcome = next
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
    }),
  }
  return fake
}

let upstream: FakeUpstream | undefined

afterEach(async () => {
  await upstream?.close()
  upstream = undefined
})

/** A relay pointed at the fake upstream's token URL. */
function relayFor(upstream: FakeUpstream): UpstreamSessionRelay {
  return new UpstreamSessionRelay({
    port: upstream.port,
    authority: upstream.authority,
    authenticatedUrl: () => `http://${upstream.authority}/?token=launch-token`,
  })
}

describe('UpstreamSessionRelay', () => {
  it('holds the dsh-auth-<hash> cookie the token exchange mints', async () => {
    upstream = await fakeUpstream()
    const relay = relayFor(upstream)
    const name = `dsh-auth-${createHash('sha256').update(upstream.authority).digest('base64url')}`

    expect(await relay.cookie()).toBe(`${name}=v1.payload.sig`)
    // A second call is served from the held session rather than a new exchange,
    // which is the whole point of caching it.
    expect(await relay.cookie()).toBe(`${name}=v1.payload.sig`)
    // The exchange is a browser-equivalent visit of the launch-token URL, with
    // upstream's own authority as Host — the authority the cookie is bound to.
    expect(upstream.seen[0]).toEqual({ url: '/?token=launch-token', host: upstream.authority })
    expect(upstream.seen).toHaveLength(1)
  })

  it('ignores a Set-Cookie that is not the upstream session', async () => {
    upstream = await fakeUpstream({ outcome: 'other' })
    const relay = relayFor(upstream)

    expect(await relay.cookie()).toBeUndefined()
  })

  it('returns undefined when the exchange is refused and re-acquires later', async () => {
    upstream = await fakeUpstream({ outcome: 'refuse' })
    const relay = relayFor(upstream)
    const name = `dsh-auth-${createHash('sha256').update(upstream.authority).digest('base64url')}`

    expect(await relay.cookie()).toBeUndefined()

    // Upstream starts accepting the launch token (secret rotation, restart):
    // the next call exchanges again instead of caching the failure.
    upstream.value = 'v1.fresh.sig'
    upstream.outcome = 'mint'
    expect(await relay.cookie()).toBe(`${name}=v1.fresh.sig`)
    expect(upstream.seen).toHaveLength(2)
  })

  it('forgets a session upstream rejected via invalidate()', async () => {
    upstream = await fakeUpstream()
    const relay = relayFor(upstream)
    const name = `dsh-auth-${createHash('sha256').update(upstream.authority).digest('base64url')}`

    expect(await relay.cookie()).toBe(`${name}=v1.payload.sig`)
    relay.invalidate()

    // Nothing is held any more, so the next call has to exchange again — the
    // seen-length assertion below is what proves it did.
    upstream.value = 'v1.rotated.sig'
    expect(await relay.cookie()).toBe(`${name}=v1.rotated.sig`)
    expect(upstream.seen).toHaveLength(2)
  })
})

describe('UpstreamSessionRelay logging', () => {
  /**
   * A relay that captures its log lines. Takes the fake as a parameter and
   * closes over that local, not the module-level `upstream` — a closure over
   * the reassignable module binding is `FakeUpstream | undefined` to tsc.
   */
  function loggingRelay(
    fake: FakeUpstream,
    authenticatedUrl: () => string | undefined,
    lines: string[],
  ): UpstreamSessionRelay {
    return new UpstreamSessionRelay({
      port: fake.port,
      authority: fake.authority,
      authenticatedUrl,
      log: (message) => lines.push(message),
    })
  }

  it('reports the exchange outcome and the cookie it accepted', async () => {
    const fake = await fakeUpstream()
    upstream = fake
    const lines: string[] = []
    const relay = loggingRelay(fake, () => `http://${fake.authority}/?token=launch-token`, lines)

    await relay.cookie()
    expect(lines.some(line => line.includes('acquiring session from'))).toBe(true)
    expect(lines.some(line => line.includes('got dsh-auth-') && line.includes('maxAge='))).toBe(true)
    expect(lines).toContain('session acquired and cached')
  })

  it('names the cookies it saw when none is the upstream session', async () => {
    // The whole point of the sink: a mis-named cookie is otherwise
    // indistinguishable from a base that has no browser sessions at all.
    const fake = await fakeUpstream({ outcome: 'other' })
    upstream = fake
    const lines: string[] = []
    const relay = loggingRelay(fake, () => `http://${fake.authority}/?token=launch-token`, lines)

    expect(await relay.cookie()).toBeUndefined()
    expect(lines.some(line => line.includes('no dsh-auth-* cookie; got:'))).toBe(true)
  })

  it('keeps the held session when authenticatedUrl() is transiently unavailable', async () => {
    // Inside the refresh window on every call, so cookie() reaches doExchange.
    const fake = await fakeUpstream({ maxAge: 30 })
    upstream = fake
    let url: string | undefined = `http://${fake.authority}/?token=launch-token`
    const lines: string[] = []
    const relay = loggingRelay(fake, () => url, lines)
    const name = `dsh-auth-${createHash('sha256').update(fake.authority).digest('base64url')}`

    expect(await relay.cookie()).toBe(`${name}=v1.payload.sig`)

    // The connection service drops out mid-flight. Dropping to undefined here
    // would forward with no cookie and draw a 401, so the held session rides.
    url = undefined
    fake.value = 'v1.rotated.sig'
    expect(await relay.cookie()).toBe(`${name}=v1.payload.sig`)
    expect(lines.some(line => line.includes('authenticatedUrl() returned undefined'))).toBe(true)
    expect(fake.seen).toHaveLength(1)
  })

  it('logs an invalidation only when a session was actually held', async () => {
    const fake = await fakeUpstream()
    upstream = fake
    const lines: string[] = []
    const relay = loggingRelay(fake, () => `http://${fake.authority}/?token=launch-token`, lines)

    relay.invalidate()
    expect(lines).toEqual([])

    await relay.cookie()
    relay.invalidate()
    expect(lines).toContain('invalidating held session (upstream rejected it)')
  })
})
