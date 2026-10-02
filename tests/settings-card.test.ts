/**
 * Settings-card tests: the field codecs, and the slot the card registers into.
 *
 * The card's tri-state codec is load-bearing: it posts a patch of the edited
 * fields only, so a field the card cannot express is left to the composition
 * layer rather than reset to a schema default. `auto` (unset) and an explicit
 * `false` must therefore stay distinguishable, or the plaintext-proxy escape
 * hatch for `secureCookies` silently reverts and the `/__login` loop comes
 * back.
 *
 * The registration tests below pin the other half of that contract: a card
 * registered into a slot the Plugins page no longer renders disappears without
 * a sound, which is how the 0.1.7 slot rename went unnoticed.
 *
 * @module tests/settings-card
 */

import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import {
  FIELDS,
  LanGatewayCard,
  formatValue,
  parseValue,
  passwordProblem,
  passwordStatus,
  refusedByGateway,
  type FieldDef,
} from '../src/client/lan-gateway-card.tsx'
import { MIN_PASSWORD_LENGTH } from '../src/config-fields.ts'

/** The tri-state field definition, as the card declares it. */
const secureCookies = FIELDS.find(f => f.field === 'secureCookies') as FieldDef

describe('settings-card tri-state field', () => {
  it('is present in the field table (an absent field would be wiped by save)', () => {
    // save() rebuilds the POST body from FIELDS, and replace() drops anything
    // missing — so a key absent here cannot survive a settings-card save.
    expect(secureCookies).toBeDefined()
    expect(secureCookies.kind).toBe('tristate')
  })

  it('renders unset as "auto", never as "false"', () => {
    expect(formatValue(secureCookies, undefined)).toBe('auto')
    expect(formatValue(secureCookies, true)).toBe('true')
    expect(formatValue(secureCookies, false)).toBe('false')
  })

  it('parses "auto" as a clear so the key re-inherits the composition layer', () => {
    expect(parseValue(secureCookies, 'auto')).toEqual({ kind: 'clear' })
  })

  it('parses an explicit false as a set, not as unset', () => {
    expect(parseValue(secureCookies, 'false')).toEqual({ kind: 'set', value: false })
    expect(parseValue(secureCookies, 'true')).toEqual({ kind: 'set', value: true })
  })

  it('round-trips every state through the codec', () => {
    for (const value of [undefined, true, false] as const) {
      const text = formatValue(secureCookies, value)
      const write = parseValue(secureCookies, text)
      // 'auto' is the only state that clears; the other two must set.
      if (value === undefined) expect(write).toEqual({ kind: 'clear' })
      else expect(write).toEqual({ kind: 'set', value })
    }
  })

  it('rejects an unknown option rather than inventing a value', () => {
    expect(parseValue(secureCookies, 'yes')).toBeUndefined()
  })
})

describe('settings-card unreachable-route copy', () => {
  it("recognizes the gateway's own bare refusal", () => {
    // The gateway answers the plugin's whole prefix with this exact pair; the
    // card uses it to say "you are not on the host loopback" instead of the
    // generic message.
    expect(refusedByGateway(403, 'forbidden')).toBe(true)
    expect(refusedByGateway(403, 'forbidden\n')).toBe(true)
  })

  it('does not mistake any other failure for the gateway', () => {
    // dsh's own answers, a missing route, and a network drop all take the
    // generic copy — guessing "gateway" there would send a host-local user
    // chasing a proxy that was never involved.
    expect(refusedByGateway(403, 'Forbidden')).toBe(false)
    expect(refusedByGateway(403, '<html>SPA fallback</html>')).toBe(false)
    expect(refusedByGateway(401, 'forbidden')).toBe(false)
    expect(refusedByGateway(404, 'forbidden')).toBe(false)
    expect(refusedByGateway(200, 'forbidden')).toBe(false)
    expect(refusedByGateway(502, '')).toBe(false)
  })
})

describe('settings-card password draft gate', () => {
  it('takes its length bound from the constant the host route enforces', () => {
    // The route answers 400 below this bound, so the card must not enable a
    // draft the route would reject.
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1)
    const exact = 'a'.repeat(MIN_PASSWORD_LENGTH)
    expect(passwordProblem(short, short)).toBe('tooShort')
    expect(passwordProblem(exact, exact)).toBeNull()
  })

  it('reports the length problem before a mismatched confirmation', () => {
    // An untouched confirm box is a mismatch too; the useful message is the
    // one about the password itself.
    expect(passwordProblem('short', '')).toBe('tooShort')
  })

  it('reports a mismatch once the length is satisfied', () => {
    expect(passwordProblem('correct-horse', 'correct-hors')).toBe('mismatch')
  })

  it('refuses to submit an empty form', () => {
    expect(passwordProblem('', '')).toBe('tooShort')
  })

  it('accepts a confirmed draft of at least the minimum length', () => {
    expect(passwordProblem('correct-horse', 'correct-horse')).toBeNull()
  })
})

describe('settings-card password badge', () => {
  it('treats an absent flag as unknown, never as "not set"', () => {
    // A host from before the password route reports no `passwordSet` at all. A
    // card that reads that as "not set" announces that a gateway which is
    // demonstrably running (it cannot start without a credential) has none —
    // observed live: the new card against a running 0.6.0 host.
    expect(passwordStatus(undefined)).toBe('unknown')
  })

  it('reads the two reported states', () => {
    expect(passwordStatus(true)).toBe('set')
    expect(passwordStatus(false)).toBe('unset')
  })
})

/** One captured `ctx.slots.register` call, with the component it carried. */
interface Registration {
  name: string
  key?: string
  id?: string
  component: unknown
}

/**
 * The client seams `apply()` drives, captured instead of mounted: the slots
 * ledger, and a `configForms.whileServed` that serves a namespace only when a
 * test says so.
 */
function fakeClientContext(): {
  ctx: never
  registrations: Registration[]
  watched: () => readonly string[] | undefined
  serve: (namespace: string) => void
  unserve: () => void
} {
  const registrations: Registration[] = []
  let watched: readonly string[] | undefined
  let registerFn: ((served: ReadonlySet<string>) => () => void) | undefined
  let dispose: (() => void) | undefined

  const ctx = {
    effect(body: () => unknown) { body() },
    configForms: {
      whileServed(
        namespaces: readonly string[],
        register: (served: ReadonlySet<string>) => () => void,
      ): () => void {
        watched = namespaces
        registerFn = register
        return () => { registerFn = undefined }
      },
    },
    slots: {
      inject(_name: string, callback: () => () => void): () => void {
        return callback()
      },
      register(options: Registration, component: unknown): () => void {
        registrations.push({ ...options, component })
        return () => {
          const index = registrations.findIndex(entry => entry.component === component)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
  }

  return {
    ctx: ctx as never,
    registrations,
    watched: () => watched,
    serve: (namespace: string) => {
      dispose = registerFn?.(new Set([namespace]))
    },
    unserve: () => { dispose?.() },
  }
}

describe('settings-card slot registration', () => {
  it('requires the slots ledger and the settings mirror', () => {
    // The card mounts through `slots`; the gate that decides whether the Host
    // can serve a write at all reads `configForms`.
    expect(inject).toContain('slots')
    expect(inject).toContain('configForms')
  })

  it("registers as this bundle's own configuration, under the profile entry id", () => {
    const h = fakeClientContext()
    apply(h.ctx)

    // The Host must serve the entry first: an unserved namespace means no
    // Loader entry, so every save would answer 409.
    expect(h.registrations).toHaveLength(0)
    expect(h.watched()).toEqual(['dsh-lan-gateway'])

    h.serve('dsh-lan-gateway')
    expect(h.registrations).toHaveLength(1)
    // `plugins.item` is the OCCUPIED slot dsh reserves for the official
    // settings pages: registering there made the card pose as an official
    // plugin. A bundle's own configuration goes in `plugins.bundle.config`,
    // keyed by the BUNDLE's package name.
    expect(h.registrations[0]?.name).toBe('plugins.bundle.config')
    expect(h.registrations[0]?.key).toBe('@riceawa/dsh-lan-gateway')
    expect(h.registrations[0]?.component).toBe(LanGatewayCard)
  })

  it('withdraws the card once the Host stops serving the entry', () => {
    const h = fakeClientContext()
    apply(h.ctx)
    h.serve('dsh-lan-gateway')
    expect(h.registrations).toHaveLength(1)

    h.unserve()
    expect(h.registrations).toHaveLength(0)
  })
})
