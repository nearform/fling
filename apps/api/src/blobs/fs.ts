/**
 * Filesystem storage for dev and tests: objects are files under `root` (`.fling-dev/` at the repo
 * root in dev). Presigned PUTs point at the API's own `PUT /dev-upload/<key>?exp=&sig=` route,
 * which calls `acceptUpload`: the scheme in `signed-upload.ts` (shared with R2Blobs), with the
 * body's SHA-256 checked like S3 checks `x-amz-checksum-sha256`.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { type SignedUploadRequest, signUpload, verifyUpload } from './signed-upload.ts'
import type { Blobs, PresignedPut } from './types.ts'

export class FsBlobs implements Blobs {
  readonly root: string

  constructor(
    root: string,
    /** origin the API is reachable on, e.g. http://localhost:47101 */
    private baseUrl: string,
    private secret: string,
    private now: () => number = Date.now
  ) {
    this.root = resolve(root)
  }

  /** Resolve a key inside root; throws on traversal. */
  pathFor(key: string): string {
    const full = resolve(this.root, key)
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new Error('bad key')
    return full
  }

  private get signer() {
    return { secret: this.secret, baseUrl: this.baseUrl, route: '/dev-upload', now: this.now }
  }

  async presignPut(
    key: string,
    opts: { contentType: string; cacheControl: string; sha256: string; expiresIn?: number }
  ): Promise<PresignedPut> {
    return signUpload(this.signer, key, opts)
  }

  /** Verify a dev upload and store it. Returns false if the signature/expiry/checksum is bad. */
  async acceptUpload(input: SignedUploadRequest & { body: Uint8Array }): Promise<boolean> {
    if (!verifyUpload(this.signer, input)) return false
    if (createHash('sha256').update(input.body).digest('base64') !== input.checksum) return false
    const file = this.pathFor(input.key)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, input.body)
    return true
  }

  async head(key: string) {
    try {
      const s = await stat(this.pathFor(key))
      return s.isFile() ? { size: s.size } : null
    } catch {
      return null
    }
  }

  async put(key: string, body: Uint8Array) {
    const file = this.pathFor(key)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, body)
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(key)))
    } catch {
      return null
    }
  }

  async putJson(key: string, value: unknown) {
    const file = this.pathFor(key)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(value))
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.pathFor(key), 'utf8')) as T
    } catch {
      return null
    }
  }

  /** Files carry no metadata here: the dev sites server derives the content type from the name. */
  async copy(from: string, to: string) {
    const file = this.pathFor(to)
    await mkdir(dirname(file), { recursive: true })
    await copyFile(this.pathFor(from), file)
  }

  async delete(key: string) {
    await rm(this.pathFor(key), { force: true })
  }

  async deletePrefix(prefix: string) {
    // As strict as S3Blobs, so a file key passed here fails in tests rather than in production.
    if (!prefix.endsWith('/')) throw new Error('deletePrefix needs a `dir/` prefix')
    const dir = this.pathFor(prefix.replace(/\/+$/, ''))
    if (dir === this.root) throw new Error('refusing to delete storage root')
    await rm(join(dir), { recursive: true, force: true })
  }
}
