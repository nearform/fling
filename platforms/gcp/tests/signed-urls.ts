/**
 * Cloud Storage's checks on a V4 signed URL, in front of fake-gcs-server, which accepts any signed
 * URL and never compares a body with its Content-MD5. What it checks is what Cloud Storage
 * documents (https://cloud.google.com/storage/docs/authentication/signatures and
 * .../canonical-requests): the RSA-SHA256 signature over the canonical request (method, path,
 * query, the signed headers with the values the request sends, UNSIGNED-PAYLOAD), checked with the
 * signing key's public half; X-Goog-Date plus X-Goog-Expires; and, on a PUT that sends
 * Content-MD5, the body's MD5 (400 BadDigest). Only a request that passes goes on to the store.
 *
 * So the Blobs conformance suite proves GcsBlobs signs what Cloud Storage would refuse to accept
 * otherwise. It does not prove Cloud Storage itself refuses it: only a real bucket can, and no
 * automated test reaches one.
 */
import { createHash, createVerify, type KeyObject } from 'node:crypto'

/** RFC 3986 encoding, as the canonical query takes it. */
const encode = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

const refuse = (status: number, code: string) =>
  new Response(`<Error><Code>${code}</Code></Error>`, { status })

/** `X-Goog-Date` (YYYYMMDD'T'HHMMSS'Z') as epoch ms. */
const dateOf = (s: string) =>
  Date.parse(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`
  )

export function verifyingStore(publicKey: KeyObject) {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    const q = u.searchParams
    const signature = q.get('X-Goog-Signature')
    const date = q.get('X-Goog-Date')
    const expires = Number(q.get('X-Goog-Expires'))
    const signed = (q.get('X-Goog-SignedHeaders') ?? '').split(';').filter(Boolean)
    if (!signature || !date || !Number.isFinite(expires) || !signed.includes('host')) {
      return refuse(400, 'AuthenticationRequired')
    }
    if (Date.now() > dateOf(date) + expires * 1000) return refuse(400, 'ExpiredToken')
    const query = [...q.entries()]
      .filter(([k]) => k !== 'X-Goog-Signature')
      .map(([k, v]) => [encode(k), encode(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&')
    const sent = (name: string) =>
      name === 'host' ? u.hostname : (headers.get(name) ?? '').trim().replace(/\s{2,}/g, ' ')
    const canonical = [
      method,
      u.pathname,
      query,
      signed.map(h => `${h}:${sent(h)}\n`).join(''),
      signed.join(';'),
      'UNSIGNED-PAYLOAD',
    ].join('\n')
    const scope = (q.get('X-Goog-Credential') ?? '').split('/').slice(1).join('/')
    const toSign = [
      'GOOG4-RSA-SHA256',
      date,
      scope,
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n')
    const verifier = createVerify('RSA-SHA256').update(toSign)
    if (!verifier.verify(publicKey, Buffer.from(signature, 'hex'))) {
      return refuse(403, 'SignatureDoesNotMatch')
    }
    const body =
      init.body === undefined || init.body === null
        ? undefined
        : new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
    const md5 = headers.get('content-md5')
    if (method === 'PUT' && md5 !== null) {
      const actual = createHash('md5')
        .update(body ?? new Uint8Array())
        .digest('base64')
      if (actual !== md5) return refuse(400, 'BadDigest')
    }
    return fetch(url, { method, headers, ...(body ? { body } : {}) })
  }
}
