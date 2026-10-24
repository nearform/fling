/**
 * Signed upload URLs for backends that can't presign their own (FsBlobs in dev/tests, R2Blobs on
 * Cloudflare, which has no S3 keys): the URL points at a route of our own, `<baseUrl><route>/<key>
 * ?exp=&sig=`, and the HMAC covers key, expiry, Content-Type, Cache-Control and the body's SHA-256.
 * The client sends the checksum as `x-amz-checksum-sha256` (base64), exactly as it does for an S3
 * presigned PUT, so one client works against every backend. Verifying the signature is this
 * module's job; checking the body against the checksum is the route's (it holds the bytes).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PresignedPut } from './types.ts'

export interface UploadSigner {
  /** HMAC key (the session secret) */
  secret: string
  /** origin the route is reachable on, e.g. http://localhost:47101 */
  baseUrl: string
  /** path the route is mounted at, e.g. `/dev-upload` */
  route: string
  now?: () => number
}

/** What a signed upload request carries, as the route reads it. */
export interface SignedUploadRequest {
  key: string
  exp: string | undefined
  sig: string | undefined
  contentType: string
  cacheControl: string
  /** the `x-amz-checksum-sha256` header (base64) */
  checksum: string
}

function sign(secret: string, key: string, exp: number, type: string, cache: string, sha: string) {
  return createHmac('sha256', secret)
    .update(`${key}\n${exp}\n${type}\n${cache}\n${sha}`)
    .digest('base64url')
}

export function signUpload(
  signer: UploadSigner,
  key: string,
  opts: { contentType: string; cacheControl: string; sha256: string; expiresIn?: number }
): PresignedPut {
  const now = signer.now ?? Date.now
  const exp = Math.floor(now() / 1000) + (opts.expiresIn ?? 900)
  const checksum = Buffer.from(opts.sha256, 'hex').toString('base64')
  const sig = sign(signer.secret, key, exp, opts.contentType, opts.cacheControl, checksum)
  const path = key.split('/').map(encodeURIComponent).join('/')
  return {
    url: `${signer.baseUrl}${signer.route}/${path}?exp=${exp}&sig=${sig}`,
    headers: {
      'content-type': opts.contentType,
      'cache-control': opts.cacheControl,
      'x-amz-checksum-sha256': checksum,
    },
  }
}

/** Whether the request's signature is good and unexpired (the body is not checked here). */
export function verifyUpload(
  signer: Pick<UploadSigner, 'secret' | 'now'>,
  input: SignedUploadRequest
): boolean {
  const now = signer.now ?? Date.now
  const exp = Number(input.exp)
  if (!input.sig || !Number.isFinite(exp) || exp < Math.floor(now() / 1000)) return false
  const expected = Buffer.from(
    sign(signer.secret, input.key, exp, input.contentType, input.cacheControl, input.checksum)
  )
  const given = Buffer.from(input.sig)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** The key a signed upload URL path names, given the route it is mounted at. */
export const uploadKeyFromPath = (path: string, route: string) =>
  path.startsWith(`${route}/`) ? decodeURIComponent(path.slice(route.length + 1)) : null
