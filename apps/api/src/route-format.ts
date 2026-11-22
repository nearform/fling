/**
 * The route table's format (kvs.ts RouteFormat), which an admin chooses (Admin → Routes): `json`,
 * which every release's edge reads, or `compact`, about a third of the size, for a store with a
 * size limit (CloudFront KeyValueStore: 5 MB). The edge reads both, so a choice takes effect as
 * the API writes: every route write from then on is in the chosen format (sites.ts
 * `syncRouteTable`, paths.ts `syncPathRoute`), and maintenance rewrites every site's routes into
 * it, a page of the site directory at a time from where it got to (`rewriteRoutes`), until it has
 * done them all.
 *
 * The choice is stored (`ROUTES/FORMAT`) and read on every route write, never cached, so no
 * instance goes on writing the format it replaced. Rolling back to a release whose edge reads
 * only `json` needs `json` chosen and its rewrite finished first: the admin page says so.
 */
import type { RouteFormat } from '@fling/shared'
import { ensure } from './admin.ts'
import { audit } from './audit.ts'
import { syncPathRoute } from './paths.ts'
import type { Principal } from './policy.ts'
import { syncRouteTable } from './sites.ts'
import type { RouteFormatRecord } from './store/types.ts'
import type { Deps } from './types.ts'

/** Directory entries read a query of the rewrite. */
const REWRITE_PAGE = 50

/** The format route writes take now: the chosen one, or `json`. */
export async function routeFormat(deps: Deps): Promise<RouteFormat> {
  return (await deps.store.getRouteFormat())?.format ?? 'json'
}

/** What Admin → Routes shows of the route table: its format, the rewrite, how full it is. */
export async function routeTableStatus(deps: Deps, p: Principal) {
  ensure(p, 'admin.routes.read')
  const record = await deps.store.getRouteFormat()
  const usage = deps.routeTable.usage ? await deps.routeTable.usage() : null
  return {
    format: record?.format ?? 'json',
    ...(record ? { setBy: record.setBy, setAt: record.setAt, rewrite: record.rewrite } : {}),
    usage,
  }
}

/**
 * Choose the format the API writes, and start maintenance's rewrite of every site's routes into
 * it. Choosing the format already chosen starts the rewrite again.
 */
export async function setRouteFormat(deps: Deps, p: Principal, format: RouteFormat) {
  ensure(p, 'admin.routes.write')
  const record: RouteFormatRecord = {
    format,
    setBy: p.email,
    setAt: deps.clock.now().toISOString(),
    rewrite: { after: null, sites: 0 },
  }
  await deps.store.putRouteFormat(record)
  await audit(deps, { action: 'routes.format', actor: p.email, target: format })
  return routeTableStatus(deps, p)
}

/**
 * Maintenance's part: rewrite the routes of the next sites in the directory into the chosen
 * format, until the deadline or the end; returns how many it did. Each page's progress is kept
 * only while the choice is the one it began under, so a newer choice starts its own rewrite.
 */
export async function rewriteRoutes(deps: Deps, deadline: number | undefined): Promise<number> {
  let record = await deps.store.getRouteFormat()
  if (!record || record.rewrite.finishedAt) return 0
  let done = 0
  for (;;) {
    const page = await deps.store.pageSites({ after: record.rewrite.after, limit: REWRITE_PAGE })
    let after = record.rewrite.after
    let sites = record.rewrite.sites
    let stopped = false
    for (const entry of page.sites) {
      if (deadline !== undefined && Date.now() > deadline) {
        stopped = true
        break
      }
      const site = await deps.store.findSite(entry.name)
      if (site) {
        await syncRouteTable(deps, site)
        for (const path of await deps.store.listPaths(site.id))
          await syncPathRoute(deps, site, path)
        sites++
        done++
      }
      after = entry.name
    }
    const finished = !stopped && !page.more
    const next: RouteFormatRecord = {
      ...record,
      rewrite: {
        after,
        sites,
        ...(finished ? { finishedAt: deps.clock.now().toISOString() } : {}),
      },
    }
    if (!(await deps.store.putRouteFormat(next, record.setAt))) return done
    if (finished) {
      console.log(JSON.stringify({ level: 'info', msg: 'route rewrite finished', ...next }))
    }
    if (finished || stopped) return done
    record = next
  }
}
