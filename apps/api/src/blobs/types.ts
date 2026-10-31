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

export interface Blobs {
  /**
   * A PUT URL for exactly one body: the object whose SHA-256 is `sha256` (hex). Any other bytes
   * are rejected, so the URL can never replace what was published with something else.
   */
  presignPut(
    key: string,
    opts: { contentType: string; cacheControl: string; sha256: string; expiresIn?: number }
  ): Promise<PresignedPut>
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
   * Server-side copy of one object, keeping its content type and cache-control: a path publish
   * carries the rest of the site forward into the new version this way. Throws when `from` is
   * missing; overwrites `to`.
   */
  copy(from: string, to: string): Promise<void>
  /** Delete one object; a missing object is not an error. */
  delete(key: string): Promise<void>
  /** Delete every object under a `dir/` prefix. Throws unless the prefix ends in `/`. */
  deletePrefix(prefix: string): Promise<void>
}

/** Where a pending version's manifest is kept (under the site prefix, never routed by the edge). */
export const manifestKey = (siteId: string, versionId: string) =>
  `sites/${siteId}/_manifests/${versionId}.json`

/**
 * A site's thumbnail (a PNG of its home page; `SiteRecord.thumbnail`): under the site prefix, so
 * deleting the site deletes it, and outside every version, so the edge never serves it.
 */
export const thumbnailKey = (siteId: string) => `sites/${siteId}/_thumbnail.png`

/** Staging area for chunked MCP uploads (never routed by the edge; deleted on finish). */
export const uploadPrefix = (uploadId: string) => `uploads/${uploadId}/`
