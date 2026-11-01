/**
 * Signed blob URLs for backends that can't presign their own (FsBlobs in dev/tests, R2Blobs on
 * Cloudflare, which has no S3 keys): the URL points at a route of our own, `<baseUrl><route>/<key>
 * ?exp=&sig=`, signed with an HMAC of the session secret.
 *
 * - **Uploads** (`signUpload`): the HMAC covers key, expiry, Content-Type, Cache-Control and the
 *   body's SHA-256. The client sends the checksum as `x-amz-checksum-sha256` (base64), exactly as
 *   it does for an S3 presigned PUT, so one client works against every backend. Verifying the
 *   signature is this module's job; checking the body against the checksum is the route's (it
 *   holds the bytes).
 * - **Downloads** (`signDownload`): the HMAC covers the method, key and expiry, so a download URL
 *   can never be used to upload, nor for another object.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PresignedPut } from './types.ts'

export interface UrlSigner {
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

/** What a signed download request carries, as the route reads it. */
export interface SignedDownloadRequest {
  key: string
  exp: string | undefined
  sig: string | undefined
}

const DEFAULT_EXPIRES_IN = 900

const hmac = (secret: string, message: string) =>
  createHmac('sha256', secret).update(message).digest('base64url')

const uploadMessage = (key: string, exp: number, type: string, cache: string, sha: string) =>
  `${key}\n${exp}\n${type}\n${cache}\n${sha}`

const downloadMessage = (key: string, exp: number) => `GET\n${key}\n${exp}`

const expiry = (signer: Pick<UrlSigner, 'now'>, expiresIn = DEFAULT_EXPIRES_IN) =>
  Math.floor((signer.now ?? Date.now)() / 1000) + expiresIn

const urlFor = (signer: UrlSigner, key: string, exp: number, sig: string) =>
  `${signer.baseUrl}${signer.route}/${key.split('/').map(encodeURIComponent).join('/')}?exp=${exp}&sig=${sig}`

/** Whether `sig` is the HMAC of `message` and `exp` has not passed. */
function verify(
  signer: Pick<UrlSigner, 'secret' | 'now'>,
  exp: string | undefined,
  sig: string | undefined,
  message: (exp: number) => string
): boolean {
  const now = signer.now ?? Date.now
  const at = Number(exp)
  if (!sig || !Number.isFinite(at) || at < Math.floor(now() / 1000)) return false
  const expected = Buffer.from(hmac(signer.secret, message(at)))
  const given = Buffer.from(sig)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export function signUpload(
  signer: UrlSigner,
  key: string,
  opts: { contentType: string; cacheControl: string; sha256: string; expiresIn?: number }
): PresignedPut {
  const exp = expiry(signer, opts.expiresIn)
  const checksum = Buffer.from(opts.sha256, 'hex').toString('base64')
  const sig = hmac(
    signer.secret,
    uploadMessage(key, exp, opts.contentType, opts.cacheControl, checksum)
  )
  return {
    url: urlFor(signer, key, exp, sig),
    headers: {
      'content-type': opts.contentType,
      'cache-control': opts.cacheControl,
      'x-amz-checksum-sha256': checksum,
    },
  }
}

/** Whether the request's signature is good and unexpired (the body is not checked here). */
export function verifyUpload(
  signer: Pick<UrlSigner, 'secret' | 'now'>,
  input: SignedUploadRequest
): boolean {
  return verify(signer, input.exp, input.sig, exp =>
    uploadMessage(input.key, exp, input.contentType, input.cacheControl, input.checksum)
  )
}

/** A GET URL for one object, good for `expiresIn` seconds (default 15 minutes). */
export function signDownload(signer: UrlSigner, key: string, opts: { expiresIn?: number } = {}) {
  const exp = expiry(signer, opts.expiresIn)
  return urlFor(signer, key, exp, hmac(signer.secret, downloadMessage(key, exp)))
}

/** Whether a download request's signature is good and unexpired. */
export function verifyDownload(
  signer: Pick<UrlSigner, 'secret' | 'now'>,
  input: SignedDownloadRequest
): boolean {
  return verify(signer, input.exp, input.sig, exp => downloadMessage(input.key, exp))
}

/** The key a signed URL path names, given the route it is mounted at. */
export const keyFromPath = (path: string, route: string) => {
  if (!path.startsWith(`${route}/`)) return null
  try {
    return decodeURIComponent(path.slice(route.length + 1))
  } catch {
    return null
  }
}
