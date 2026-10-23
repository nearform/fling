/** Errors that become the `{ error: { code, message } }` envelope (see `error-handler.ts`). */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500,
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
