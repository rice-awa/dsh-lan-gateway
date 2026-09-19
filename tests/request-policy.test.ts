/**
 * Unit tests for the gateway's request-decision seam: path normalization and
 * the owned prefix, the cookie and same-site gates, and the header transforms
 * in both directions. Every decision here is a pure function of a literal
 * object, which is the point of the module — these assertions used to require a
 * live socket and a running upstream.
 */

import { describe, expect, it } from 'vitest'
import {
  isCrossSiteRequest,
  isLoopbackHost,
  isOwnedPath,
  loginOriginAllowed,
  pathOf,
  READ_ONLY_METHODS,
  requiresLogin,
  sameSiteAllowed,
  sessionCookie,
  upstreamRequestHeaders,
  downstreamResponseHeaders,
  upgradeResponseHeaders,
  withoutUpstreamSessionPairs,
} from '../src/request-policy.ts'

describe('pathOf', () => {
  it('collapses dot segments the way dsh routes them', () => {
    // The load-bearing case: a raw-string prefix test does not see this as an
    // owned path, so it stays in the relay, lands on the loopback-only config
    // route once Host is rewritten, and reaches the plugin's own surface.
    expect(pathOf('/foo/../lan-gateway/config')).toBe('/lan-gateway/config')
    expect(pathOf('/a/b/../../__login')).toBe('/__login')
    expect(pathOf('/./lan-gateway/config')).toBe('/lan-gateway/config')
  })

  it('strips the query', () => {
    expect(pathOf('/__login?limited=1')).toBe('/__login')
    expect(pathOf('/lan-gateway/config?x=1&y=2')).toBe('/lan-gateway/config')
  })

  it('strips trailing slashes, and maps the bare root back to /', () => {
    expect(pathOf('/__logout/')).toBe('/__logout')
    expect(pathOf('/lan-gateway/config//')).toBe('/lan-gateway/config')
    expect(pathOf('/')).toBe('/')
    expect(pathOf('')).toBe('/')
  })

  it('returns an unparseable target unchanged', () => {
    // Nothing sensible to normalize; dsh routes it nowhere either.
    expect(pathOf('http://[bad')).toBe('http://[bad')
  })
})

describe('isOwnedPath', () => {
  it('owns the prefix and the bare name, and nothing that merely starts with it', () => {
    expect(isOwnedPath('/lan-gateway')).toBe(true)
    expect(isOwnedPath('/lan-gateway/')).toBe(true)
    expect(isOwnedPath('/lan-gateway/config')).toBe(true)
    expect(isOwnedPath('/lan-gatewayevil')).toBe(false)
    expect(isOwnedPath('/lan-gatewayx/config')).toBe(false)
    expect(isOwnedPath('/')).toBe(false)
  })
})

describe('isLoopbackHost', () => {
  it('accepts the spellings a URL parser produces for loopback', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.1.2.3')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
  })

  it('refuses everything else, including LAN space and malformed quads', () => {
    expect(isLoopbackHost('10.0.0.1')).toBe(false)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('127.0.0.256')).toBe(false)
    expect(isLoopbackHost('127.0.0')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackHost('')).toBe(false)
  })
})

describe('requiresLogin', () => {
  it('demands a session from every source by default', () => {
    expect(requiresLogin('loopback', false)).toBe(true)
    expect(requiresLogin('lan', false)).toBe(true)
    expect(requiresLogin('internet', false)).toBe(true)
  })

  it('exempts lan and loopback only under the explicit opt-in', () => {
    expect(requiresLogin('loopback', true)).toBe(false)
    expect(requiresLogin('lan', true)).toBe(false)
    // The internet is never exempt: lanPasswordless is a "trust my LAN" choice.
    expect(requiresLogin('internet', true)).toBe(true)
  })
})

describe('sessionCookie', () => {
  it('picks its own cookie out of a multi-cookie header', () => {
    expect(sessionCookie({ cookie: 'a=1; dsh_gw_auth=payload.sig; b=2' }, 'dsh_gw_auth'))
      .toBe('payload.sig')
  })

  it('is undefined when the header is absent or names another cookie', () => {
    expect(sessionCookie({}, 'dsh_gw_auth')).toBeUndefined()
    expect(sessionCookie({ cookie: 'other=1' }, 'dsh_gw_auth')).toBeUndefined()
  })

  it('does not match a cookie whose name merely starts the same way', () => {
    // `dsh_gw_authx=` must not answer for `dsh_gw_auth`; the test is on the
    // exact `name=` prefix, not a bare substring.
    expect(sessionCookie({ cookie: 'dsh_gw_authx=stolen' }, 'dsh_gw_auth')).toBeUndefined()
  })
})

describe('isCrossSiteRequest', () => {
  it('refuses an explicit cross-site fetch', () => {
    expect(isCrossSiteRequest({ 'sec-fetch-site': 'cross-site' })).toBe(true)
  })

  it('refuses an Origin that disagrees with the Host the browser used', () => {
    expect(isCrossSiteRequest({ origin: 'http://evil.example', host: 'gw.example:3081' })).toBe(true)
    // Same host, different port is a different origin.
    expect(isCrossSiteRequest({ origin: 'http://gw.example:9999', host: 'gw.example:3081' })).toBe(true)
  })

  it('allows a matching Origin, and allows no Origin at all', () => {
    expect(isCrossSiteRequest({ origin: 'http://gw.example:3081', host: 'gw.example:3081' })).toBe(false)
    expect(isCrossSiteRequest({ host: 'gw.example:3081' })).toBe(false)
  })

  it('reads only signals a cross-site page cannot suppress', () => {
    // sec-fetch-site same-origin is the browser's own claim; it is not treated
    // as proof, but it is not a refusal either.
    expect(isCrossSiteRequest({ 'sec-fetch-site': 'same-origin', host: 'gw.example' })).toBe(false)
  })
})

describe('sameSiteAllowed', () => {
  it('refuses every cross-site request, read or state-changing', () => {
    const crossSite = { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }
    expect(sameSiteAllowed(crossSite, false)).toBe(false)
    expect(sameSiteAllowed(crossSite, true)).toBe(false)
  })

  it('lets an Origin-less read through, for navigations and non-browser clients', () => {
    expect(sameSiteAllowed({ method: 'GET', headers: {} }, false)).toBe(true)
    expect(sameSiteAllowed({ method: 'HEAD', headers: {} }, false)).toBe(true)
    expect(sameSiteAllowed({ method: 'OPTIONS', headers: {} }, false)).toBe(true)
  })

  it('requires an Origin on a state-changing request', () => {
    expect(sameSiteAllowed({ method: 'POST', headers: {} }, false)).toBe(false)
    expect(sameSiteAllowed({ method: 'DELETE', headers: {} }, false)).toBe(false)
    expect(sameSiteAllowed({ method: 'POST', headers: { origin: 'http://h:1', host: 'h:1' } }, false))
      .toBe(true)
  })

  it('treats a missing method as a read, matching node defaulting to GET', () => {
    expect(sameSiteAllowed({ headers: {} }, false)).toBe(true)
  })

  it('always requires an Origin on a WebSocket upgrade', () => {
    expect(sameSiteAllowed({ method: 'GET', headers: {} }, true)).toBe(false)
    expect(sameSiteAllowed({ method: 'GET', headers: { origin: 'http://h:1', host: 'h:1' } }, true))
      .toBe(true)
  })
})

describe('loginOriginAllowed', () => {
  it('accepts a non-browser client that sends no Origin', () => {
    // curl and the dsh CLI legitimately post the form without an Origin;
    // requiring one would lock them out of signing in.
    expect(loginOriginAllowed({ host: 'gw.example:3081' })).toBe(true)
    expect(loginOriginAllowed({ host: 'gw.example:3081', 'sec-fetch-site': 'same-origin' })).toBe(true)
  })

  it('refuses what a cross-site page cannot forge', () => {
    expect(loginOriginAllowed({ host: 'gw.example', 'sec-fetch-site': 'cross-site' })).toBe(false)
    expect(loginOriginAllowed({ host: 'gw.example', origin: 'http://evil.example' })).toBe(false)
  })

  it('stops short of the state-changing rule, deliberately', () => {
    // sameSiteAllowed would refuse this; the login route must not, or a
    // browser-less client could never sign in.
    expect(sameSiteAllowed({ method: 'POST', headers: { host: 'gw.example' } }, false)).toBe(false)
    expect(loginOriginAllowed({ host: 'gw.example' })).toBe(true)
  })
})

describe('READ_ONLY_METHODS', () => {
  it('names exactly the methods a browser sends without a CSRF-meaningful body', () => {
    expect([...READ_ONLY_METHODS].sort()).toEqual(['GET', 'HEAD', 'OPTIONS'])
  })
})

describe('withoutUpstreamSessionPairs', () => {
  it('drops the whole dsh-auth namespace and keeps everything else', () => {
    expect(withoutUpstreamSessionPairs('a=1; dsh-auth-abc=stale; b=2')).toBe('a=1; b=2')
    expect(withoutUpstreamSessionPairs('dsh-auth-abc=stale')).toBe('')
    expect(withoutUpstreamSessionPairs('a=1;b=2')).toBe('a=1; b=2')
  })

  it('drops a bare prefix pair too, matching the filter rule', () => {
    // A pair named exactly `dsh-auth-` is inside the namespace the relay owns,
    // so it cannot shadow the relayed session either.
    expect(withoutUpstreamSessionPairs('dsh-auth-=x; keep=1')).toBe('keep=1')
  })

  it('is unfazed by empty pairs and surrounding whitespace', () => {
    expect(withoutUpstreamSessionPairs(';; a=1 ;;')).toBe('a=1')
    expect(withoutUpstreamSessionPairs('')).toBe('')
  })
})

describe('upstreamRequestHeaders', () => {
  const opts = { dshPort: 3080, keepUpgrade: false }

  it('rewrites Host and Origin to the loopback upstream', () => {
    const out = upstreamRequestHeaders(
      { host: 'gw.example:3081', origin: 'http://gw.example:3081' },
      opts,
    )
    expect(out.host).toBe('127.0.0.1:3080')
    expect(out.origin).toBe('http://127.0.0.1:3080')
  })

  it('leaves an absent Origin absent rather than inventing one', () => {
    const out = upstreamRequestHeaders({ host: 'gw.example:3081' }, opts)
    expect(out.origin).toBeUndefined()
  })

  it('drops caller-supplied forwarding headers instead of relaying a forgeable claim', () => {
    const out = upstreamRequestHeaders(
      {
        host: 'h:1',
        'x-forwarded-for': '1.2.3.4',
        'x-forwarded-proto': 'https',
        'x-real-ip': '1.2.3.4',
        forwarded: 'for=1.2.3.4',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-port': '443',
      },
      opts,
    )
    for (const name of ['x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'forwarded',
      'x-forwarded-host', 'x-forwarded-port']) {
      expect(out[name]).toBeUndefined()
    }
  })

  it('drops hop-by-hop headers when not upgrading', () => {
    const out = upstreamRequestHeaders(
      { host: 'h:1', connection: 'keep-alive', upgrade: 'websocket', 'proxy-connection': 'x' },
      opts,
    )
    expect(out.connection).toBeUndefined()
    expect(out.upgrade).toBeUndefined()
    expect(out['proxy-connection']).toBeUndefined()
  })

  it('keeps Connection and Upgrade only on the upgrade path', () => {
    const out = upstreamRequestHeaders(
      { host: 'h:1', connection: 'Upgrade', upgrade: 'websocket' },
      { dshPort: 3080, keepUpgrade: true },
    )
    expect(out.connection).toBe('Upgrade')
    expect(out.upgrade).toBe('websocket')
  })

  it('clears the upstream cookie namespace, then appends the relayed session', () => {
    const out = upstreamRequestHeaders(
      { host: 'h:1', cookie: 'ui=1; dsh-auth-stale=old' },
      { dshPort: 3080, keepUpgrade: false, upstreamCookie: 'dsh-auth-live=new' },
    )
    // The stale client pair must be gone, or upstream reads it first and the
    // relayed session never takes effect.
    expect(out.cookie).toBe('ui=1; dsh-auth-live=new')
  })

  it('sends the relayed session alone when the client holds no cookies', () => {
    const out = upstreamRequestHeaders(
      { host: 'h:1' },
      { dshPort: 3080, keepUpgrade: false, upstreamCookie: 'dsh-auth-live=new' },
    )
    expect(out.cookie).toBe('dsh-auth-live=new')
  })

  it('omits the cookie header entirely when nothing is left to send', () => {
    const out = upstreamRequestHeaders({ host: 'h:1', cookie: 'dsh-auth-stale=old' }, opts)
    expect(out.cookie).toBeUndefined()
  })

  it('ignores an empty relayed session', () => {
    const out = upstreamRequestHeaders(
      { host: 'h:1', cookie: 'ui=1' },
      { dshPort: 3080, keepUpgrade: false, upstreamCookie: '' },
    )
    expect(out.cookie).toBe('ui=1')
  })
})

describe('downstreamResponseHeaders', () => {
  it('drops hop-by-hop headers', () => {
    const out = downstreamResponseHeaders({
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'content-type': 'text/plain',
    })
    expect(out.connection).toBeUndefined()
    expect(out['transfer-encoding']).toBeUndefined()
    expect(out['content-type']).toBe('text/plain')
  })

  it('withholds the upstream session cookie from the client', () => {
    // Upstream's only cookie-minting route is the launch-token exchange, so a
    // client that could read this would walk away with a durable credential.
    const out = downstreamResponseHeaders({
      'set-cookie': ['dsh-auth-abc=v1.sig; Path=/; HttpOnly'],
    })
    expect(out['set-cookie']).toBeUndefined()
  })

  it('passes through cookies from any other route', () => {
    // Node types `set-cookie` as a list on IncomingHttpHeaders; a lone string
    // is tolerated at runtime by the transform but is not a legal literal here.
    const out = downstreamResponseHeaders({ 'set-cookie': ['ui=dark; Path=/'] })
    expect(out['set-cookie']).toEqual(['ui=dark; Path=/'])
  })

  it('filters per-entry, keeping unrelated cookies out of a mixed list', () => {
    const out = downstreamResponseHeaders({
      'set-cookie': ['dsh-auth-abc=v1.sig', 'ui=dark'],
    })
    expect(out['set-cookie']).toEqual(['ui=dark'])
  })

  it('keeps a pair that is only inside the namespace, not a session', () => {
    // The bare prefix carries no session, so it is not withheld — this is the
    // filter/accept distinction: filtering drops the prefix, accepting needs a
    // name past it.
    const out = downstreamResponseHeaders({ 'set-cookie': ['dsh-auth-=x'] })
    expect(out['set-cookie']).toEqual(['dsh-auth-=x'])
  })

  it('drops undefined-valued entries rather than emitting them', () => {
    const out = downstreamResponseHeaders({ 'content-type': 'text/plain', etag: undefined })
    expect(Object.hasOwn(out, 'etag')).toBe(false)
  })
})

describe('upgradeResponseHeaders', () => {
  it('keeps Connection and Upgrade, which 101 is exactly about', () => {
    const out = upgradeResponseHeaders({
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-accept': 'abc',
    })
    expect(out.connection).toBe('Upgrade')
    expect(out.upgrade).toBe('websocket')
    expect(out['sec-websocket-accept']).toBe('abc')
  })

  it('still drops the other hop-by-hop headers', () => {
    const out = upgradeResponseHeaders({ 'keep-alive': 'timeout=5', 'transfer-encoding': 'chunked' })
    expect(out['keep-alive']).toBeUndefined()
    expect(out['transfer-encoding']).toBeUndefined()
  })

  it('applies the same cookie rule as the ordinary response path', () => {
    // Relaxing Connection/Upgrade must not relax the cookie filter with them.
    const out = upgradeResponseHeaders({ 'set-cookie': ['dsh-auth-abc=v1.sig', 'ui=dark'] })
    expect(out['set-cookie']).toEqual(['ui=dark'])
  })
})
