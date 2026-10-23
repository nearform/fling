/**
 * Login handoff. The CLI listens on the first free port in 8765–8770 at
 * `http://127.0.0.1:<port>/callback`, opens
 * `<server>/auth/cli?redirect_uri=<callback>&hostname=<host>&state=<random>` in the browser, and the
 * server — after Google sign-in — redirects back with `?key=<api key>` (or `?error=<code>`). If the
 * server echoes `state`, it must match. The callback answers a tiny self-closing page, the CLI
 * verifies the key with `GET /api/me`, and writes the config. Five-minute timeout. The key is never
 * printed in full.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { hostname as osHostname } from 'node:os'
import { type Me, MeSchema } from '@fling/shared'
import { createApiClient, type FetchLike } from './api.ts'
import { type ConfigStore, redactKey } from './config.ts'
import type { OpenLike } from './context.ts'
import { CliError } from './errors.ts'
import { BIN_NAME } from './package-info.ts'
import type { Logger } from './utils/logger.ts'

export const CALLBACK_PORT_START = 8765
export const CALLBACK_PORT_END = 8770
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
export const CALLBACK_PATH = '/callback'
/** Server route that starts the browser side of the handoff. */
export const AUTH_CLI_PATH = '/auth/cli'

export interface LoginOptions {
  serverUrl: string
  store: ConfigStore
  log: Logger
  open: OpenLike
  fetch?: FetchLike
  timeoutMs?: number
  hostname?: string
  /** Called with the sign-in URL before the browser is opened (the MCP server reports it). */
  onAuthUrl?: (url: string) => void
}

export interface LoginResult {
  serverUrl: string
  keyPrefix: string
  user: Me
}

export async function loginFlow(options: LoginOptions): Promise<LoginResult> {
  const { serverUrl, store, log } = options
  const state = randomBytes(16).toString('hex')
  const callback = await startCallbackServer({ state, timeoutMs: options.timeoutMs })
  try {
    const authUrl = buildAuthUrl(serverUrl, callback.url, options.hostname ?? osHostname(), state)
    options.onAuthUrl?.(authUrl)
    log.info(`Opening your browser to sign in at ${serverUrl}`)
    log.hint(`If it does not open, visit: ${authUrl}`)
    try {
      await options.open(authUrl)
    } catch (error) {
      log.warn(`Could not open a browser (${(error as Error).message}); open the URL above.`)
    }
    log.info('Waiting for the browser to complete sign-in (5-minute timeout)…')

    const { key } = await callback.result
    const client = createApiClient({ serverUrl, apiKey: key, fetch: options.fetch })
    const user = await client.request('GET', '/api/me', { schema: MeSchema })

    await store.update({
      serverUrl,
      apiKey: key,
      user: { email: user.email, name: user.name, userSlug: user.userSlug },
    })
    const keyPrefix = redactKey(key)
    log.success(`Signed in as ${user.email}`)
    log.hint(`Server: ${serverUrl}`)
    log.hint(`API key: ${keyPrefix} (stored in ${store.file})`)
    return { serverUrl, keyPrefix, user }
  } finally {
    callback.close()
  }
}

export function buildAuthUrl(
  serverUrl: string,
  callbackUrl: string,
  hostname: string,
  state: string
): string {
  const url = new URL(AUTH_CLI_PATH, `${serverUrl.replace(/\/+$/, '')}/`)
  url.searchParams.set('redirect_uri', callbackUrl)
  url.searchParams.set('hostname', hostname)
  url.searchParams.set('state', state)
  return url.toString()
}

// ---- Loopback callback server ------------------------------------------------------------

export interface CallbackData {
  key: string
}

export interface CallbackServer {
  port: number
  url: string
  /** Resolves with the key, rejects on `?error=`, a missing key, a wrong state, or timeout. */
  result: Promise<CallbackData>
  close(): void
}

type Settle = { resolve: (d: CallbackData) => void; reject: (e: Error) => void }

/** Pure parse of a callback URL — the part of the handoff worth unit-testing on its own. */
export function parseCallback(
  url: URL,
  expectedState: string | undefined
): { ok: true; key: string } | { ok: false; message: string } {
  const error = url.searchParams.get('error')
  if (error) return { ok: false, message: `Sign-in failed: ${error}` }
  const state = url.searchParams.get('state')
  if (state !== null && expectedState !== undefined && state !== expectedState) {
    return {
      ok: false,
      message: 'Sign-in failed: state mismatch (the callback was not for this login)',
    }
  }
  const key = url.searchParams.get('key')
  if (!key) return { ok: false, message: 'Callback missing required parameter: key' }
  return { ok: true, key }
}

export async function startCallbackServer(
  options: { state?: string; timeoutMs?: number } = {}
): Promise<CallbackServer> {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS
  let settle: Settle | undefined
  let timer: NodeJS.Timeout | undefined
  const result = new Promise<CallbackData>((resolve, reject) => {
    settle = { resolve, reject }
  }).finally(() => clearTimeout(timer))
  // Mark handled: the browser may hit the callback before the caller awaits `result`.
  result.catch(() => {})

  const server = createServer((req, res) => handleCallback(req, res, port, options.state, settle))
  const port = await listenOnFreePort(server)
  timer = setTimeout(() => {
    settle?.reject(
      new CliError(
        `Timed out after ${Math.round(timeoutMs / 60_000) || 1} minute(s) waiting for the browser`,
        { hint: `Run \`${BIN_NAME} login\` again and finish signing in within 5 minutes.` }
      )
    )
  }, timeoutMs)

  return {
    port,
    url: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    result,
    close: () => {
      clearTimeout(timer)
      server.close()
      server.closeAllConnections?.()
    },
  }
}

function handleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  expectedState: string | undefined,
  settle: Settle | undefined
): void {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
    return
  }
  const parsed = parseCallback(url, expectedState)
  if (!parsed.ok) {
    respondHtml(
      res,
      400,
      'Sign-in failed',
      `${escapeHtml(parsed.message)}. Return to the terminal and try again.`
    )
    settle?.reject(
      new CliError(parsed.message, { hint: `Run \`${BIN_NAME} login\` to try again.` })
    )
    return
  }
  respondHtml(res, 200, 'Signed in', 'You can close this tab and return to the terminal.', true)
  settle?.resolve({ key: parsed.key })
}

function respondHtml(
  res: ServerResponse,
  status: number,
  title: string,
  body: string,
  close = false
) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Fling — ${title}</title></head>
<body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#111">
<h1 style="font-size:1.5rem">${title}</h1><p>${body}</p>
${close ? '<script>setTimeout(function(){window.close()},800)</script>' : ''}
</body></html>`
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close',
  })
  res.end(html)
}

function listenOnFreePort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = CALLBACK_PORT_START
    const tryNext = () => {
      if (port > CALLBACK_PORT_END) {
        reject(
          new CliError(
            `No free port in ${CALLBACK_PORT_START}–${CALLBACK_PORT_END} for the login callback`,
            {
              hint: 'Another login may be in progress; close it or free one of those ports.',
            }
          )
        )
        return
      }
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
          port += 1
          tryNext()
        } else reject(error)
      })
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error')
        resolve(port)
      })
    }
    tryNext()
  })
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
}
