/**
 * The body of a fetched answer, made safe to hand on in a new Response. Node's fetch (undici)
 * cancels the body stream of a Response it made once that Response is garbage collected, if
 * nothing has started reading the stream. `new Response(res.body, …)` doesn't start reading it,
 * so a collection between the wrap and the caller's read cancels the answer, and the caller's
 * read throws "Body is unusable". Piping through an identity stream locks the fetched body, which
 * undici leaves alone, and keeps backpressure, errors and cancellation flowing both ways.
 *
 * Every adapter that passes on what it fetched (a server's answer, a probe's) goes through here.
 */
export const heldBody = (res: Response): ReadableStream<Uint8Array> | null =>
  res.body ? res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()) : null
