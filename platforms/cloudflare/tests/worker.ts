/**
 * The Worker the tests run in workerd (bundled by miniflare.ts): R2Blobs' upload route, so signed
 * uploads arrive as real requests and stream into R2 the way they will in production.
 */
import type { R2Bucket } from '@cloudflare/workers-types'
import { R2Blobs, UPLOAD_ROUTE } from '../src/blobs/r2.ts'

interface Env {
  BUCKET: R2Bucket
  UPLOAD_SECRET: string
}

export default {
  async fetch(request: Request, env: Env) {
    const blobs = new R2Blobs(env.BUCKET, { secret: env.UPLOAD_SECRET, baseUrl: '' })
    if (new URL(request.url).pathname.startsWith(`${UPLOAD_ROUTE}/`)) {
      return blobs.handleUpload(request)
    }
    return new Response(null, { status: 404 })
  },
}
