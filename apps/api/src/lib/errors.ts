/** Errors that become the `{ error: { code, message } }` envelope (see `error-handler.ts`). */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500,
    readonly code: string,
    message: string,
    /** extra fields merged into `error` (e.g. `missing` paths on a 409 finalize) */
    readonly extra?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const badRequest = (message: string, code = 'bad_request') =>
  new ApiError(400, code, message)
export const unauthorized = (message = 'Not signed in') =>
  new ApiError(401, 'unauthenticated', message)
export const forbidden = (message: string, code = 'forbidden') => new ApiError(403, code, message)
export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message)
export const conflict = (message: string, code = 'conflict', extra?: Record<string, unknown>) =>
  new ApiError(409, code, message, extra)

/**
 * A short reference for an unexpected failure: logged beside the real error and shown to the
 * person who hit it, so an admin finds the one line in the logs from what they are sent.
 */
export const errorRef = () => crypto.randomUUID().replaceAll('-', '').slice(0, 10)

/** Log an unexpected error under its reference (the logs are an admin's, never a viewer's). */
export function logUnexpected(ref: string, context: Record<string, unknown>, err: unknown) {
  console.error(
    JSON.stringify({
      level: 'error',
      ref,
      ...context,
      err: String(err),
      stack: (err as Error | undefined)?.stack,
    })
  )
}

/** What to do next, for a fault in Fling itself, naming the reference to pass on. */
export const reportFault = (ref: string) =>
  `Try again in a minute; if it happens again, tell your Fling's admin and give them this reference: ${ref}`
