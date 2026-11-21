/**
 * A request body read with a cap: what a route that takes raw bytes (an upload) reads, so a
 * request can't make the server hold more than it allows. A declared Content-Length over the cap
 * is refused before any byte is read; otherwise the stream is read until it passes the cap.
 */

/** The body, or null once it passes `max` bytes (read no further). */
export async function bodyUpTo(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN)
  if (declared > max) return null
  if (!request.body) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = request.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const body = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    body.set(chunk, at)
    at += chunk.byteLength
  }
  return body
}
