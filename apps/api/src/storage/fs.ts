/**
 * Filesystem storage for dev and tests: objects are files under `root` (`.fling-dev/` at the repo
 * root in dev). Presigned PUTs point at the API's own `PUT /dev-upload/<key>?exp=&sig=` route,
 * which calls `acceptUpload`. The signature covers key, expiry, Content-Type, Cache-Control and the
 * body's SHA-256, which is checked like S3 checks `x-amz-checksum-sha256`.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { PresignedPut, Storage } from './types.ts'

export class FsStorage implements Storage {
  readonly root: string

  constructor(
    root: string,
    /** origin the API is reachable on, e.g. http://localhost:3001 */
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

  private sign(key: string, exp: number, contentType: string, cacheControl: string, sha: string) {
    return createHmac('sha256', this.secret)
      .update(`${key}\n${exp}\n${contentType}\n${cacheControl}\n${sha}`)
      .digest('base64url')
  }

  async presignPut(
    key: string,
    opts: { contentType: string; cacheControl: string; sha256: string; expiresIn?: number }
  ): Promise<PresignedPut> {
    const exp = Math.floor(this.now() / 1000) + (opts.expiresIn ?? 900)
    const checksum = Buffer.from(opts.sha256, 'hex').toString('base64')
    const sig = this.sign(key, exp, opts.contentType, opts.cacheControl, checksum)
    const path = key.split('/').map(encodeURIComponent).join('/')
    return {
      url: `${this.baseUrl}/dev-upload/${path}?exp=${exp}&sig=${sig}`,
      headers: {
        'content-type': opts.contentType,
        'cache-control': opts.cacheControl,
        'x-amz-checksum-sha256': checksum,
      },
    }
  }

  /** Verify a dev upload and store it. Returns false if the signature/expiry is bad. */
  async acceptUpload(input: {
    key: string
    exp: string | undefined
    sig: string | undefined
    contentType: string
    cacheControl: string
    /** the `x-amz-checksum-sha256` header (base64) */
    checksum: string
    body: Uint8Array
  }): Promise<boolean> {
    const exp = Number(input.exp)
    if (!input.sig || !Number.isFinite(exp) || exp < Math.floor(this.now() / 1000)) return false
    const expected = Buffer.from(
      this.sign(input.key, exp, input.contentType, input.cacheControl, input.checksum)
    )
    const given = Buffer.from(input.sig)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false
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

  async deletePrefix(prefix: string) {
    // Prefixes used by the app always end at a directory boundary (`sites/<id>/`).
    const dir = this.pathFor(prefix.replace(/\/+$/, ''))
    if (dir === this.root) throw new Error('refusing to delete storage root')
    await rm(join(dir), { recursive: true, force: true })
  }
}
