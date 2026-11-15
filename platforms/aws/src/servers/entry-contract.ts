/**
 * What a site server's Web Function entry (web-entry.ts, `index.mjs` in the zip) and the API's
 * adapter (site-servers.ts, server-logs.ts) agree on: the environment the revision carries, the
 * header the entry marks its own failures with, and the request line it prints. Kept free of
 * anything heavy, since both sides bundle it.
 */
import { SERVER_LOG_DAYS, type ServerLogLine } from '@fling/shared/site-server'

/** The revision's environment, besides the site secrets themselves. */
export const ENTRY_ENV = {
  /** the version the revision runs (the request line names it) */
  version: 'FLING_VERSION_ID',
  /** the declared secrets' names, comma-separated (helper.mjs `secret()` and a fetch handler's env) */
  secretNames: 'FLING_SECRET_NAMES',
  /** the wall time per request, in seconds, streams included */
  timeoutSeconds: 'FLING_TIMEOUT_SECONDS',
  /** the largest request body, in bytes */
  bodyBytes: 'FLING_BODY_BYTES',
} as const

/** The file the Web Function starts (AWS_LAMBDA_NODEJS_ENTRYPOINT), at the zip's root. */
export const ENTRY_FILE = 'index.mjs'
/** The author's bundle in the zip. */
export const ENTRY_BUNDLE = 'server.mjs'
/** The version's own files in the zip, for `file()`. */
export const ENTRY_FILES_DIR = 'files'

/**
 * Set by the entry on an answer it gave because the author's server could not: `crashed` (the
 * bundle threw while loading), `not-listening` (nothing listened on PORT in time). The start probe
 * counts either as no answer.
 */
export const SERVER_ERROR_HEADER = 'x-fling-server-error'

/** What the entry prints for each request: a JSON object on one stdout line. */
export function requestLogText(line: ServerLogLine): string {
  return JSON.stringify({ fling: 'request', line })
}

/** A request line the entry printed, read back from the log; null for anything else. */
export function parseRequestLogText(text: string): ServerLogLine | null {
  if (!text.startsWith('{"fling":"request"')) return null
  try {
    const v = JSON.parse(text) as { fling?: unknown; line?: Partial<ServerLogLine> }
    const l = v.line
    if (v.fling !== 'request' || !l || typeof l.at !== 'string' || typeof l.versionId !== 'string')
      return null
    return { ...l, kind: 'request' } as ServerLogLine
  } catch {
    return null
  }
}

/** How long both log groups keep a server's log: the core's SERVER_LOG_DAYS. */
export const LOG_RETENTION_DAYS = SERVER_LOG_DAYS
