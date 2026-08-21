/**
 * The gateway's own login surface: a self-contained HTML form served at
 * `/__login` (never proxied) and the form-post handler that validates the
 * password and issues the session cookie.
 *
 * @module @rice-awa/dsh-lan-gateway/login
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

/** Path the gateway owns and never forwards. */
export const LOGIN_PATH = '/__login' as const

/** The cookie name used for the signed session. */
export const COOKIE_NAME = 'dsh_gw_auth' as const

export interface LoginPageOptions {
  error?: string
  /** Optional login attempt counter to show when rate-limited. */
  limited?: boolean
}

/** Render the self-contained login page. */
export function renderLoginPage(opts: LoginPageOptions = {}): string {
  const errorHtml = opts.limited
    ? '<p class="error">Too many attempts — wait a minute and try again.</p>'
    : opts.error
      ? `<p class="error">${escapeHtml(opts.error)}</p>`
      : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepSeek Harness — Remote Access</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0f1115; color: #e6e9ef; font: 14px/1.5 system-ui, -apple-system, sans-serif;
  }
  .card {
    width: min(360px, 90vw); padding: 32px 28px; border: 1px solid #262b36; border-radius: 12px;
    background: #161a21; box-shadow: 0 8px 30px rgba(0,0,0,.4);
  }
  h1 { font-size: 17px; margin: 0 0 4px; }
  p.sub { color: #8b93a3; margin: 0 0 20px; font-size: 13px; }
  label { display: block; font-size: 12px; color: #aab2c1; margin-bottom: 6px; }
  input[type=password] {
    width: 100%; padding: 10px 12px; border: 1px solid #2d3442; border-radius: 8px;
    background: #0f1115; color: #e6e9ef; font-size: 14px;
  }
  button {
    width: 100%; margin-top: 16px; padding: 10px; border: 0; border-radius: 8px;
    background: #4f6ef7; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  button:hover { background: #5c7afa; }
  p.error { color: #ff7b72; font-size: 13px; margin: 12px 0 0; }
</style>
</head>
<body>
  <form class="card" method="post" action="${LOGIN_PATH}">
    <h1>DeepSeek Harness</h1>
    <p class="sub">This instance requires a password from your network location.</p>
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autofocus autocomplete="current-password" required>
    ${errorHtml}
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`
}

/** Minimal HTML-escape for the error string interpolated into the page. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Serve the GET login page. */
export function serveLoginGet(res: ServerResponse, extraHeaders: OutgoingHttpHeaders = {}): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(renderLoginPage())
}

/** Parse an application/x-www-form-urlencoded body into its fields. */
export function parseFormBody(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of body.split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const key = eq === -1 ? pair : pair.slice(0, eq)
    const value = eq === -1 ? '' : pair.slice(eq + 1)
    out[decodeURIComponent(key.replaceAll('+', ' '))] = decodeURIComponent(value.replaceAll('+', ' '))
  }
  return out
}

/** Read a request body up to a byte ceiling, rejecting anything larger. */
export function readBody(req: IncomingMessage, maxBytes: number, res: ServerResponse): Promise<string | undefined> {
  return new Promise((resolve) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        res.writeHead(413)
        res.end()
        resolve(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', () => {
      res.writeHead(400)
      res.end()
      resolve(undefined)
    })
  })
}
