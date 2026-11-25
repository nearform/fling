/**
 * Blob storage port (the sites bucket). Implementations: `fs.ts` (dev/tests) here, S3 in
 * platforms/aws, R2 in platforms/cloudflare. `packages/conformance/src/blobs.ts` holds them to
 * the same behaviour.
 */
export interface PresignedPut {
  url: string
  /** headers the client must send with the PUT — they are part of the signature */
  headers: Record<string, string>
}

/** What a presigned PUT is bound to. */
export interface PresignPutOptions {
  contentType: string
  cacheControl: string
  /** the body's SHA-256, hex: always given */
  sha256: string
  /** the body's MD5, base64, when the client sent it (older clients send none) */
  md5?: string
  /** seconds (default 900) */
  expiresIn?: number
}

export interface Blobs {
  /**
   * The digest presigned uploads are bound to (default `sha256`). With `md5`, nothing ties an
   * upload to the manifest's SHA-256, which the version id and kept-file reuse trust, and an MD5
   * collision could replace a file after it was checked while its URL is still good. So uploads
   * go to a staging key (`stagedObjectKey`), and publication copies each file into the version,
   * which no presigned URL can write, before it checks the copy's SHA-256 and scans it.
   */
  readonly uploadDigest?: 'sha256' | 'md5'
  /**
   * A PUT URL for exactly one body: the object whose digest was signed. Any other bytes are
   * rejected, so the URL can never replace what was published with something else. The store
   * binds whichever digest it checks: the SHA-256 (S3, R2, the core's signed routes) or the MD5
   * (`Content-MD5`: GCS, Azure Blob, S3-compatible stores). A store that checks only an MD5,
   * asked without one, signs one of the host's upload routes instead (host-uploads.ts), where the
   * host checks the SHA-256 itself. The client sends exactly the headers returned.
   */
  presignPut(key: string, opts: PresignPutOptions): Promise<PresignedPut>
  /**
   * A GET URL for one object, good for `expiresIn` seconds (default 900): how a pull hands out a
   * version's files without their bytes passing through the API. Fetching it after it expires, or
   * with the URL changed, is refused.
   */
  presignGet(key: string, opts?: { expiresIn?: number }): Promise<string>
  /** null when the object doesn't exist */
  head(key: string): Promise<{ size: number } | null>
  /** Server-side write (remote MCP publishes; chunked-upload staging). */
  put(
    key: string,
    body: Uint8Array,
    opts?: { contentType?: string; cacheControl?: string }
  ): Promise<void>
  /** null when the object doesn't exist */
  get(key: string): Promise<Uint8Array | null>
  putJson(key: string, value: unknown): Promise<void>
  getJson<T>(key: string): Promise<T | null>
  /**
   * Server-side copy of one object, keeping its content type and cache-control: a publish on a
   * base carries the base's files it keeps forward into the new version this way. Throws when `from` is
   * missing; overwrites `to`.
   */
  copy(from: string, to: string): Promise<void>
  /** Delete one object; a missing object is not an error. */
  delete(key: string): Promise<void>
  /** Delete every object under a `dir/` prefix. Throws unless the prefix ends in `/`. */
  deletePrefix(prefix: string): Promise<void>
}

/** Upload URLs from publication's stage() live this long; the CLI uploads straight away. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60

/**
 * Where an upload to a store bound by MD5 lands (`uploadDigest: 'md5'`): under the site prefix and
 * outside every version, so the edge never serves it. Publication copies the bytes into the
 * version and checks them there; a presigned URL never names the version's own keys on such a store.
 */
export const stagedObjectKey = (siteId: string, versionId: string, path: string) =>
  `sites/${siteId}/_staged/${versionId}/${path}`
export const stagedPrefix = (siteId: string, versionId: string) =>
  `sites/${siteId}/_staged/${versionId}/`

/** Where a pending version's manifest is kept (under the site prefix, never routed by the edge). */
export const manifestKey = (siteId: string, versionId: string) =>
  `sites/${siteId}/_manifests/${versionId}.json`

/**
 * A version's forms config (`fling.forms.json`, forms.ts in @fling/shared), beside its manifest:
 * under the site prefix and outside every version, so the edge never serves it.
 */
export const formsKey = (siteId: string, versionId: string) =>
  `sites/${siteId}/_forms/${versionId}.json`

/**
 * A site's thumbnail (a PNG of its home page; `SiteRecord.thumbnail`): under the site prefix, so
 * deleting the site deletes it, and outside every version, so the edge never serves it.
 */
export const thumbnailKey = (siteId: string) => `sites/${siteId}/_thumbnail.png`

/** Staging area for chunked MCP uploads (never routed by the edge; deleted on finish). */
export const uploadPrefix = (uploadId: string) => `uploads/${uploadId}/`

/**
 * A deleted site's (or Path's) recovery file (deletion.ts): what a restore reads, beside the files
 * a soft delete kept. Outside every version, so the edge never serves it.
 */
export const deletedKey = (storageId: string) => `sites/${storageId}/deleted.json`
