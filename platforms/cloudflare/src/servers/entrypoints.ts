/**
 * The Fling Worker's entrypoints a site server's isolate is handed (runtime.ts), each made with
 * props for one version from the Worker's exports (`exports.SiteFiles({ props })`):
 *
 * - `SiteFiles`, the server's `FILES`: read-only, the version's own published files
 *   (`sites/<siteId>/<v>/` in R2), GET and HEAD only, 404 for a dotfile, anything under `_fling/`
 *   (the bundle among them) or outside the version. Fling's `file()` helper reads through it.
 * - `ServerTail`, its tail consumer: what the server printed, and its uncaught exceptions, as
 *   `output` lines of the site's log (R2ServerLogs, logs.ts).
 *
 * Exported from src/worker.ts, so they run in the Fling Worker with its bindings, which the
 * server's isolate never has.
 */
import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Fetcher, R2Bucket } from '@cloudflare/workers-types'
import { serverFilePath } from '@fling/shared'
import { serverLogsIn, type TailEvent, tailLines } from './logs.ts'
import type { ServerBindings } from './runtime.ts'

interface FilesEnv {
  BUCKET: R2Bucket
}

export class SiteFiles extends WorkerEntrypoint<FilesEnv, { prefix: string }> {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 })
    }
    let path: string | null
    try {
      path = serverFilePath(decodeURIComponent(new URL(request.url).pathname))
    } catch {
      path = null
    }
    if (!path) return new Response('Not found', { status: 404 })
    const key = `${this.ctx.props.prefix}${path}`
    const object =
      request.method === 'HEAD' ? await this.env.BUCKET.head(key) : await this.env.BUCKET.get(key)
    if (!object) return new Response('Not found', { status: 404 })
    const headers = new Headers()
    object.writeHttpMetadata(headers as never)
    headers.set('etag', object.httpEtag)
    const body = 'body' in object ? (object.body as unknown as ReadableStream) : null
    return new Response(request.method === 'HEAD' ? null : body, { headers })
  }
}

export class ServerTail extends WorkerEntrypoint<FilesEnv, { siteId: string; versionId: string }> {
  async tail(events: TailEvent[]) {
    const { siteId, versionId } = this.ctx.props
    const lines = tailLines(versionId, events)
    if (lines.length === 0) return
    await serverLogsIn(this.env.BUCKET)
      .later(p => this.ctx.waitUntil(p))
      .append?.(siteId, lines)
  }
}

/** The bindings a server's isolate gets, from the Worker's exports (`ctx.exports`). */
export function serverBindings(
  exports: Record<string, (options: { props: unknown }) => unknown>
): ServerBindings {
  const make = (name: string, props: unknown) => {
    const entry = exports[name]
    if (!entry) throw new Error(`The Worker doesn't export ${name}`)
    return entry({ props }) as Fetcher
  }
  return {
    files: prefix => make('SiteFiles', { prefix }),
    tail: props => make('ServerTail', props),
  }
}
