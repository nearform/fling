/**
 * The shell around one invoke, for a sites host that hands `/api/*` to a SiteServers adapter
 * itself (the local runtime's sites host; the Worker): after the routing decision said `invoke`,
 * the request goes to the version's server as serverRequestHeaders makes it, its response goes
 * out with serverCacheControl's Cache-Control, and the request line is logged (logInvoke). On AWS
 * the Web Function's entry does the same around the author's handler.
 */
import { type SiteViewer, serverCacheControl, serverRequestHeaders } from '@fling/shared'
import type { Deps } from '../types.ts'
import { serverVersion } from './index.ts'
import { logInvoke } from './logs.ts'
import type { ServerSite, SiteServers } from './types.ts'

export interface InvokeTarget {
  site: ServerSite
  /** the live version's id (the decision's `v`) */
  v: string
  /** the site isn't public (the decision's `private`) */
  private: boolean
  viewer: SiteViewer | null
}

export async function runInvoke(
  deps: Pick<Deps, 'serverLogs' | 'clock'> & { servers: SiteServers },
  request: Request,
  target: InvokeTarget
): Promise<Response> {
  const started = performance.now()
  const headers = serverRequestHeaders(request.headers, {
    siteId: target.site.id,
    v: target.v,
    viewer: target.viewer,
    private: target.private,
  })
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    redirect: 'manual',
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit)
  const res = await deps.servers.invoke(
    target.site,
    serverVersion(target.site.id, target.v),
    forwarded
  )
  const out = new Headers(res.headers)
  out.set('cache-control', serverCacheControl(res.headers.get('cache-control'), target.private))
  const url = new URL(request.url)
  await logInvoke(deps.serverLogs, deps.clock.now(), {
    siteId: target.site.id,
    versionId: target.v,
    method: request.method,
    path: url.pathname,
    status: res.status,
    ms: performance.now() - started,
    viewer: target.viewer,
  }).catch(() => {})
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
}
