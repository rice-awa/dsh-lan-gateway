# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A DeepSeek Harness (dsh) plugin: `@riceawa/dsh-lan-gateway`. `dsh web` hard-refuses `--host 0.0.0.0`, so dsh keeps binding `127.0.0.1` and this plugin runs its own reverse-proxy gateway on the unspecified address (dual-stack), rewriting `Host`/`Origin` back to loopback. Since 0.5.0 the model is default-deny (hardening for QVD-2026-57410): every source, loopback included, must present a gateway session, and against a session-capable dsh base the gateway relays one shared upstream browser session so upstream authorization still gates every request.

## Commands

pnpm is the package manager (`packageManager` field, pnpm@11.20.0). Node 22 in CI; builds target es2024.

```bash
pnpm install
pnpm build        # tsdown: builds BOTH bundles (host lib/index.js + client lib/client.js)
pnpm typecheck    # two tsconfigs, both must pass
pnpm test         # vitest run, 186 tests
npx vitest run tests/gateway.test.ts   # one file
npx vitest run -t "rate limit"         # one test by name
```

There is no lint script. `build` and `build:client` are the same `tsdown` invocation — the array config in `tsdown.config.ts` emits both bundles in one pass. `lib/` is gitignored, but `prepack` builds it, so published tarballs always carry compiled output.

Local install into a dsh profile uses `pnpm add "link:/path/to/dsh-lan-gateway"` from `~/.dsh/profiles/web` (see INSTALL.md).

## Architecture

Two bundles, one repo.

- **Host** — `src/index.ts` → `lib/index.js` (ESM, node). The cordis plugin.
- **Client** — `src/client/index.ts` → `lib/client.js` (CJS, browser), wrapped in the `window.__ModuleLoader__.load` closure the dsh web shell expects. It carries two things: an insecure-origin `crypto.randomUUID` shim installed at module scope (before any RPC mints an id, because the gateway can serve plain-HTTP LAN origins where `randomUUID` is absent) and the Settings → Plugins card. `PLATFORM_MODULES` in `tsdown.config.ts` are externals resolved from the web shell's frozen module table — never bundle them.

Host modules:

- `src/index.ts` — cordis entry (`name` / `inject` / `Config` / `apply`). Owns listener lifecycle, the `lan-gateway` settings namespace, the loopback-only `/lan-gateway/config` route the settings card reads and writes, and the `GatewayController` behind the `lan_gateway` tool. `gatewayStartProblems` (the fail-closed guard) and `resolveSecureCookies` are exported for direct unit testing.
- `src/gateway.ts` — `LanGateway`, the proxy server itself: sockets, lifecycle, the WebSocket splice. Every request *decision* it makes is delegated to `request-policy.ts`.
- `src/request-policy.ts` — the request-decision seam: `pathOf` / `isOwnedPath`, `isLoopbackHost`, `requiresLogin`, the cookie and same-site gates, and the three header transforms (`upstreamRequestHeaders`, `downstreamResponseHeaders`, `upgradeResponseHeaders`). Pure functions over a literal `RequestHead`, so the decisions are unit-testable without a socket.
- `src/config-fields.ts` — the one description of the card-driven config fields (`FIELDS` plus the `formatValue` / `parseValue` codecs). Zero-dependency and side-effect-free on purpose: the client bundle imports it for rendering, the host bundle derives `OPTIONAL_CONFIG_KEYS` and `CONFIG_FIELD_KEYS` from it, so "which keys exist" and "which keys clear on empty" have one source.
- `src/auth.ts` — pure primitives with no I/O: `classifySource` + CIDR math, `signCookie` / `verifySession` (HMAC-SHA256 over base64url JSON), `RateLimiter`, `originMatchesHost`.
- `src/state.ts` — secrets persisted to `~/.dsh/lan-gateway/state.json` (0600, atomic temp+rename).
- `src/upstream-session.ts` — the shared upstream session relay (launch-token exchange over loopback).
- `src/tls.ts` + `src/x509.ts` — cert persistence and renewal; `x509.ts` is a from-scratch DER encoder, so there is no openssl or third-party dependency for self-signed generation.
- `src/login.ts` — login page HTML plus `readBody` with a byte ceiling.
- `src/tool.ts` — the `lan_gateway` tool definition only, over the `GatewayController` interface.

### Request pipeline (`LanGateway.handleHttp`)

Order matters and is enforced before anything is forwarded:

1. `/__login` and `/__logout` — gateway-owned, never relayed.
2. Owned prefix `/lan-gateway*` → 403, so an unauthenticated remote request cannot reach the loopback-only config route through the Host rewrite.
3. Session gate: `requiresLogin(source) && !authorized` → 302 to `/__login`.
4. Same-site / Origin fence — applied *before* the rewrite, because rewriting Origin back to loopback blinds dsh's own CSRF defence. The login POST carries its own, looser fence (`loginOriginAllowed`): it must admit an Origin-less curl/CLI post, which `sameSiteAllowed` would refuse.
5. Relay to `127.0.0.1:<dshPort>`.

WebSocket upgrades run the same gates through `handleUpgrade`, and each upgraded socket is tracked against the session that opened it so sign-out can close it.

### Invariants that span files

- **Path decisions use `pathOf`, forwarding uses the raw `req.url`.** `pathOf` applies WHATWG normalization (dot-segment collapsing) and strips trailing slashes, matching how dsh's router resolves the request. Any new owned-path or route test must go through `pathOf`; a raw-string prefix test disagrees with dsh on `/foo/../lan-gateway/config`.
- **Config vs state.** Everything in `Config` is safe to appear in `--dump-config`; the cookie-signing secret and scrypt password hash live only in `state.json`. Never move a secret into the schema.
- **Default-deny.** Source classification grants nothing by itself. `lanPasswordless` is an explicit opt-in and is refused unless the base has browser-session auth (detected by the `connection` service attaching) — a "trust my LAN" choice must never reinstall the original Host-trust hole.
- **The relay owns the `dsh-auth-*` cookie namespace** in both directions: stripped from the client's `Cookie` before forwarding (a stale client cookie would otherwise shadow the relay's on every request) and stripped from upstream `Set-Cookie` before returning (upstream's only cookie-minting route is the launch-token exchange).
- **`listenerKey()` gates restarts.** A config field that changes listener behavior must be added to `listenerKey`, or a live settings change silently keeps serving the old listener. The relay-availability flag is part of the key on purpose.
- **The relay never throws.** Every failure path is silent by design, which makes a mis-named cookie indistinguishable from a base with no browser sessions — that is why it takes a `log` sink wired to `ctx.logger`.
- **`secureCookies` is tri-state.** The config route clears a key by posting `null` and schemastery passes `null` through, so `resolveSecureCookies` tests `typeof === 'boolean'`, not `!== undefined`.
- **One run intent, two writers.** The composition base (`cordis.patch.yml`) is authoritative until the settings service attaches, after which the `lan-gateway` settings section wins. The tool's `enable` / `disable` go through `setRunIntent`, which writes the `enabled` field the card also writes — so either surface can undo the other, and a restart honours whichever spoke last. Only when no settings service exists does the intent fall back to the in-memory `manualOverride`.
- **All lifecycle work is serialized.** Every start/stop/restart goes through `enqueue()`, so a config save, a password set and a tool call cannot interleave a listener teardown with a start. Anything that changes what `desiredConfig()` resolves must go through it.

### Adding a config field

Touches, at minimum: the `Config` interface and the `z.object` schema in `src/index.ts`, `listenerKey` if it affects the listener, `FIELDS` in `src/config-fields.ts` (which is what makes the card render it, the config route accept it, and `OPTIONAL_CONFIG_KEYS` clear it on empty), the `LanGatewaySettings` wire shape in the same file if it is card-editable, the i18n tables in `src/client/lan-gateway-card.tsx`, and the config table in README.md.

## Tests

- `tests/gateway.test.ts` — unit: classification, HMAC cookies, epoch, per-session revocation, password state, rate limiting.
- `tests/start-guard.test.ts` — fail-closed start guard, the config route's loopback fence, `Secure` attribute inference including the `null`-clears path.
- `tests/integration/gateway.test.ts` — real sockets against an in-process fake upstream. Source class is posed through the injectable `classifySource` on `GatewayConfig` rather than by binding other addresses.
- `tests/upstream-session.test.ts` — real loopback token exchange against an in-process minter.
- `tests/request-policy.test.ts` — the decision seam, against literal `RequestHead` objects: path normalization, owned prefix, same-site and login fences, and both directions of the header transforms.
- `tests/integration/management-plane.test.ts` — a fake cordis context running the real `apply()` with a real `SettingsProvider`, so the `lan_gateway` tool and the card's config route are exercised against one shared state. `process.env.HOME` is redirected to a temp dir; `state.ts` and `tls.ts` both resolve `homedir()` at call time, so the plugin's real files are never touched.
- `tests/integration/session-races.test.ts` — the races the audit named: a credential change landing mid-sign-in (D9) or mid-handshake (D10), and an upstream that answers a WebSocket upgrade with a non-101 (D12). `verifyPassword` is partially mocked to a hand-settled promise, because scrypt resolves too fast for the window to be observable otherwise.
- `tsconfig.json` excludes `src/client` and the two client tests; `tsconfig.client.json` (dom + `jsx: react-jsx`) includes exactly those. `pnpm typecheck` runs both, so a client-only change still needs the second config.

Intra-repo imports carry the `.ts` extension (`allowImportingTsExtensions`), and strictness is maximal: `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on, which is why optional fields are spread conditionally (`...(x !== undefined ? { x } : {})`) instead of assigned.

## Docs and release

README.md, CHANGELOG.md, INSTALL.md and `docs/` are Chinese; source comments, identifiers, and commit subjects are English. Version history belongs in CHANGELOG.md, not README — the README keeps the current version only in its badge. `docs/security/` holds the three security audit rounds; `docs/review/` holds the architecture reviews — `architecture-review-2026-09-19.md` is the one whose C1–C6 / D1–D14 findings 0.5.5 closed, so it is a historical record of that round, not a live defect list. Keep `AGENTS.md` byte-identical to this file.

Release: push a `v*` tag → `.github/workflows/release.yml` verifies the tag matches `package.json`, runs typecheck and tests, publishes through npm Trusted Publishing (GitHub OIDC, no `NPM_TOKEN`), then creates the GitHub Release with the packed tgz. A version bump therefore means `package.json`, CHANGELOG.md, and the README badge together.
