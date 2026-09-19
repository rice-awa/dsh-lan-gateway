---
name: lan-gateway
description: Manage remote (non-LAN) access to the DeepSeek Harness web GUI through the dsh-lan-gateway plugin. Use when the user asks to open the web GUI to the LAN/internet, set or change the remote-access password, rotate the session secret, or check whether remote access is currently enabled, on what port, and whether the harness base supports the shared upstream session relay.
whenToUse: The user wants the web GUI reachable from their LAN or the wider internet, wants to enable/disable that, set the login password for remote visitors, rotate the session cookie secret, or learn the current gateway status (port, target, password state, ingress encryption, upstream-session relay, session epoch).
user-invocable: true
---

# dsh-lan-gateway

The `dsh-lan-gateway` plugin lets the DeepSeek Harness web GUI be reached from the
LAN and the wider internet. dsh itself binds only to loopback (the web CLI
hard-refuses `0.0.0.0`), so this plugin runs its own reverse-proxy gateway on the
unspecified address — both families, so IPv6 clients reach it too — forwarding to
the loopback web server while rewriting Host/Origin.

Since v0.5.0 the model is **default-deny** (post-QVD-2026-57410 hardening):

- **Every source — loopback, LAN, internet — must sign in** at the gateway login
  page and present the HMAC session cookie. Nothing is granted by source alone.
- **LAN passwordless is an explicit opt-in** (`lanPasswordless: true`). When on,
  sources in `lanCidrs` (and loopback) skip the gateway login page. The listener
  refuses to enable `lanPasswordless` unless the dsh base enforces browser-session
  auth (dsh ≥ 0.1.2-rc.1), where the gateway relays one shared upstream session and
  upstream authorization still gates every request.
- **Encrypted ingress is required to start.** The listener refuses to run over
  plaintext unless TLS is on (`tlsEnabled`), a trusted terminator is declared
  (`trustedTerminator`), or `allowInsecurePlaintext: true` is set explicitly.
- A password is always required to run the gateway.

## Drive it through the `lan_gateway` tool

Do not edit state files by hand — use the `lan_gateway` tool.

- `lan_gateway` with `command: "status"` — is it listening, on which port, toward
  which dsh port, password set?, session epoch, how many signed-out sessions are
  still held, upstream-session relay state, ingress encryption, last error.
- `lan_gateway` with `command: "enable"` — start listening. If it refuses (no
  password, legacy `authRequired: false`, plaintext without opt-in, `lanPasswordless`
  without a session-capable base), the message tells you what to change.
- `lan_gateway` with `command: "disable"` — stop listening (dsh itself stays up).
- `lan_gateway` with `command: "set-password"` and `password: "<new pass>"`
  (min 8 chars) — set the login password. Setting it revokes every existing session
  (all sources, LAN included, must sign in again). Pass an empty password to clear —
  clearing stops the listener (a password is required to run).
- `lan_gateway` with `command: "rotate-secret"` — invalidate every issued login
  cookie and every live WebSocket (users must sign in again).
- `lan_gateway` with `command: "tls-regenerate"` — mint a fresh self-signed
  certificate and hot-restart the listener (tlsMode must be `self-signed`).

## After enabling

Tell the user the gateway URL they can share:

- On the LAN: `http://<lan-ip>:<gatewayPort>/` (default port `3081`) — requires the
  login password unless `lanPasswordless` is enabled for their network.
- From outside: the machine's public address or a Tailscale IP on port `3081` —
  that path always requires the password.

Remind the user which encrypted-ingress choice they are on: TLS / a trusted
terminator / explicit plaintext. If they enabled plaintext, restate the exposure
once (passwords and sessions travel in clear).

## Troubleshooting

- Gateway won't start: set a password first (`lan_gateway set-password`); check the
  fail-closed conditions — legacy `authRequired: false` must be removed, plaintext
  needs `allowInsecurePlaintext: true` or TLS/`trustedTerminator`, and
  `lanPasswordless` needs dsh ≥ 0.1.2-rc.1. `lan_gateway status` shows the last error.
- Remote visitors see a redirect loop or 403: check the login cookie (`dsh_gw_auth`)
  and that their source is classified as `internet`. A `403` on `/api` from a
  browser is the gateway's own origin/CSRF fence — a real page load carries the
  right Origin; a hand-crafted cross-site request (or a non-browser client posting
  without an Origin) does not.
- Sessions don't survive a password change / `rotate-secret`: that is by design —
  the revocation epoch advanced and all cookies (and live WebSockets) were revoked.
  Signing out is narrower: it revokes only the session that signed out, so that
  session's cookie is dead even if a copy of it was kept elsewhere, while the
  user's other devices stay signed in.
