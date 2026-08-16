---
name: lan-gateway
description: Manage remote (non-LAN) access to the DeepSeek Harness web GUI through the dsh-lan-gateway plugin. Use when the user asks to open the web GUI to the LAN/internet, set or change the remote-access password, rotate the session secret, or check whether remote access is currently enabled and what it is listening on.
whenToUse: The user wants the web GUI reachable from their LAN or the wider internet, wants to enable/disable that, set the login password for remote visitors, rotate the session cookie secret, or learn the current gateway status (port, target, password state, trusted CIDRs).
user-invocable: true
---

# dsh-lan-gateway

The `dsh-lan-gateway` plugin lets the DeepSeek Harness web GUI be reached from the
LAN and the wider internet. dsh itself binds only to loopback (the web CLI
hard-refuses `0.0.0.0`), so this plugin runs its own reverse-proxy gateway on
`0.0.0.0` that forwards to the loopback web server while rewriting Host/Origin so
the `/api` trust fence still passes.

## Access tiers

- **Loopback** (`127.0.0.1`, `::1`) — no password.
- **LAN** (RFC1918 `10/8`, `172.16/12`, `192.168/16`, link-local `169.254/16`, `fe80::/10`)
  — no password.
- **Anything else** (the public internet, CGNAT, Tailscale) — must sign in at the
  login page and receive the session cookie.

You can extend the trusted LAN ranges by editing the plugin's `lanCidrs` config.

## Drive it through the `lan_gateway` tool

Do not edit state files by hand — use the `lan_gateway` tool. The gateway refuses
to listen until a password is set (unless `authRequired` is explicitly false).

- `lan_gateway` with `command: "status"` — is it listening, on which port, toward
  which dsh port, password set?, trusted CIDRs, cookie lifetime.
- `lan_gateway` with `command: "set-password"` and `password: "<new pass>"`
  (min 8 chars) — set the remote-access password. Pass an empty password to clear.
- `lan_gateway` with `command: "enable"` — start listening on the gateway port.
- `lan_gateway` with `command: "disable"` — stop listening (dsh itself stays up).
- `lan_gateway` with `command: "rotate-secret"` — invalidate every issued login
  cookie (users must sign in again).

## After enabling

Tell the user the gateway URL they can share:

- On the LAN: `http://<lan-ip>:<gatewayPort>/` (default port `3081`).
- From outside: the machine's public address or a Tailscale IP on port
  `3081` — that path requires the password.

## Troubleshooting

- Gateway won't start: set a password first (`lan_gateway set-password`), check
  the port is free, confirm `ctx.webServer.port` (default dsh web port `3080`)
  is where dsh is actually listening.
- Remote visitors see a redirect loop or 403: check the login cookie
  (`dsh_gw_auth`) and that their source is classified as `internet`. A `403` on
  `/api` from a browser is the gateway's own origin/CSRF fence — a real page
  load carries the right Origin; a hand-crafted cross-site request does not.
