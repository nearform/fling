/**
 * The Worker the tests run in workerd (bundled by miniflare.ts): R2Blobs' upload route, so signed
 * uploads arrive as real requests and stream into R2 the way they will in production;
 * `POST /copy` runs `R2Blobs.copy` on a list of `[from, to]` pairs in workerd (where R2 streams
 * need a known length, which the Node proxy can't show); and
 * `*.sites.example.test` is the sites host (src/sites.ts) over the KV + D1 route table and R2,
 * with a stub for the assets' 404 page, review shell and robots.txt.
 */
import type { D1Database, KVNamespace, R2Bucket } from '@cloudflare/workers-types'
import { TableRouteTable } from '@fling/api/route-table/table'
import { R2Blobs, UPLOAD_ROUTE } from '../src/blobs/r2.ts'
import { CachedRouteTable } from '../src/route-table/cached.ts'
import { WorkersKvRouteTable } from '../src/route-table/kv.ts'
import { handleSiteRequest } from '../src/sites.ts'
import { D1Table } from '../src/table/d1.ts'

interface Env {
  BUCKET: R2Bucket
  KV: KVNamespace
  DB: D1Database
  UPLOAD_SECRET: string
  SITE_KEY: string
}

const TEST_APP_ORIGIN = 'https://app.example.test'

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname.startsWith(`${UPLOAD_ROUTE}/`)) {
      const blobs = new R2Blobs(env.BUCKET, { secret: env.UPLOAD_SECRET, baseUrl: '' })
      return blobs.handleUpload(request)
    }
    if (url.pathname === '/copy' && request.method === 'POST') {
      const blobs = new R2Blobs(env.BUCKET, { secret: env.UPLOAD_SECRET, baseUrl: '' })
      const pairs = (await request.json()) as [string, string][]
      const started = Date.now()
      await Promise.all(pairs.map(([from, to]) => blobs.copy(from, to)))
      return Response.json({ ms: Date.now() - started })
    }
    if (!url.hostname.endsWith('.sites.example.test')) return new Response(null, { status: 404 })
    return handleSiteRequest(request, {
      appOrigin: TEST_APP_ORIGIN,
      siteScheme: 'https',
      cookieKey: env.SITE_KEY,
      routeTable: new CachedRouteTable(
        new WorkersKvRouteTable(env.KV),
        new TableRouteTable(new D1Table(env.DB))
      ),
      revocations: new WorkersKvRouteTable(env.KV),
      bucket: env.BUCKET,
      assets: {
        fetch: async (url: string) =>
          new Response(
            url.endsWith('/_fling/review')
              ? '<p>shell for __APP_ORIGIN__</p>'
              : url.endsWith('/_fling/robots.txt')
                ? 'User-agent: *\nDisallow: /\n'
                : '<p>404 for __APP_ORIGIN__</p>'
          ),
      } as never,
    })
  },
}
