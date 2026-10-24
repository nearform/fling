/**
 * HTTP client for the Fling API — the only place `fetch` is called. Sends `Authorization: Bearer
 * <key>`, turns the error envelope `{ error: { code, message } }` into `CliApiError` (401 → exit 2,
 * 403 → exit 3) and validates success bodies with the zod contracts from `@fling/shared`. Network
 * failures are a `CliApiError` with `status: 0` so callers only ever handle one error type.
 *
 * `putUpload` is the one unauthenticated call: a PUT of file bytes to a presigned S3 URL.
 */
import { ErrorEnvelopeSchema } from '@fling/shared'
import type { z } from 'zod'
import { CliError, EXIT_ERROR, EXIT_FORBIDDEN, EXIT_NOT_LOGGED_IN } from './errors.ts'
import { BIN_NAME, PACKAGE_NAME, VERSION } from './package-info.ts'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface ApiClientOptions {
  serverUrl: string
  apiKey?: string
  fetch?: FetchLike
  timeoutMs?: number
}

export type QueryValue = string | number | boolean | undefined | null

export interface RequestOptions<T> {
  schema?: z.ZodType<T>
  query?: Record<string, QueryValue>
  body?: unknown
}

export class CliApiError extends CliError {
  readonly status: number
  readonly code?: string
  readonly body?: unknown

  constructor(options: {
    status: number
    message: string
    code?: string
    body?: unknown
    hint?: string
    cause?: unknown
  }) {
    super(options.message, {
      exitCode: exitCodeForStatus(options.status),
      hint: options.hint ?? defaultHint(options.status),
      cause: options.cause,
    })
    this.name = 'CliApiError'
    this.status = options.status
    this.code = options.code
    this.body = options.body
  }
}

export function exitCodeForStatus(status: number): number {
  if (status === 401) return EXIT_NOT_LOGGED_IN
  if (status === 403) return EXIT_FORBIDDEN
  return EXIT_ERROR
}

function defaultHint(status: number): string | undefined {
  if (status === 401) return `Run \`${BIN_NAME} login\` to authenticate.`
  if (status === 403) return 'You are not allowed to do that.'
  return undefined
}

export interface ApiClient {
  readonly serverUrl: string
  request<T = unknown>(method: Method, path: string, options?: RequestOptions<T>): Promise<T>
}

export function buildUrl(serverUrl: string, path: string, query?: Record<string, QueryValue>) {
  const url = new URL(`${serverUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const serverUrl = options.serverUrl.replace(/\/+$/, '')
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  const timeoutMs = options.timeoutMs ?? 60_000

  async function request<T>(
    method: Method,
    path: string,
    reqOptions: RequestOptions<T> = {}
  ): Promise<T> {
    const url = buildUrl(serverUrl, path, reqOptions.query)
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `${BIN_NAME}-cli/${VERSION}`,
    }
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`
    if (reqOptions.body !== undefined) headers['Content-Type'] = 'application/json'

    let response: Response
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: reqOptions.body === undefined ? undefined : JSON.stringify(reqOptions.body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      throw new CliApiError({
        status: 0,
        code: 'network_error',
        message: `Could not reach ${serverUrl} (${describeCause(cause)})`,
        hint: 'Check your connection, or the URL given by `--server` / `FLING_URL`.',
        cause,
      })
    }

    const raw = await readBody(response)
    if (!response.ok) throw errorFromResponse(response.status, raw, method, path)
    if (!reqOptions.schema) return raw as T

    const parsed = reqOptions.schema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
      throw new CliApiError({
        status: response.status,
        code: 'invalid_response',
        body: raw,
        message: `Unexpected response from ${method} ${path}${where}: ${issue?.message ?? 'invalid'}`,
        hint: `Your ${BIN_NAME} CLI may be out of date — try \`npm i -g ${PACKAGE_NAME}@latest\`.`,
      })
    }
    return parsed.data
  }

  return { serverUrl, request }
}

/** Thrown by `putUpload`; `retryable` says whether trying again could help. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

/** PUT bytes to a presigned URL with exactly the headers the server signed. */
export async function putUpload(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: Uint8Array,
  timeoutMs = 5 * 60_000
): Promise<void> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'PUT',
      headers,
      body: body as unknown as RequestInit['body'],
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (cause) {
    throw new UploadError(`network error (${describeCause(cause)})`, true)
  }
  // Drain the body so the connection can be reused.
  await response.text().catch(() => '')
  if (response.ok) return
  const retryable = response.status >= 500 || response.status === 408 || response.status === 429
  throw new UploadError(`HTTP ${response.status}`, retryable)
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function errorFromResponse(status: number, body: unknown, method: string, path: string) {
  const envelope = ErrorEnvelopeSchema.safeParse(body)
  if (envelope.success) {
    const { code } = envelope.data.error
    const error = new CliApiError({
      status,
      code,
      body,
      message: envelope.data.error.message,
      hint: code ? NEVER_PUBLISHED_HINTS[code] : undefined,
    })
    // The server's secret checks (the guarantee behind the CLI's own): keep the details for --json.
    const extra = (body as { error?: { findings?: unknown; paths?: unknown } }).error
    if (Array.isArray(extra?.findings)) Object.assign(error, { findings: extra.findings })
    if (Array.isArray(extra?.paths)) Object.assign(error, { paths: extra.paths })
    return error
  }
  return new CliApiError({ status, body, message: `${method} ${path} failed with HTTP ${status}` })
}

/** Hints for the server refusing dotfiles, secret files and secrets (no override exists). */
const NEVER_PUBLISHED_HINTS: Record<string, string> = {
  secret_detected:
    'Remove the secret from the file (and rotate it if it was ever shared), or add the file to .flingignore if the site does not need it.',
  secret_file:
    'Move the secret files out of the folder, or add them to .flingignore if the site does not need them.',
  dotfile: `Dotfiles are never flung. Update the CLI (\`npm i -g ${PACKAGE_NAME}@latest\`), which skips them.`,
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause
    if (inner instanceof Error && 'code' in inner) return String((inner as { code: unknown }).code)
    if (cause.name === 'TimeoutError') return 'timed out'
    return cause.message
  }
  return String(cause)
}
