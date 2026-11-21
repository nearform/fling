/**
 * The options a Node site server is started again with after its host restarts (NodeSiteServers'
 * `optionsFor`): its version's, as the core makes them at activation, or null when the site or
 * the version's server is gone. dev.ts and the Node host (platforms/node) start servers this way.
 */
import type { Deps } from '../../types.ts'
import { optionsFor } from '../index.ts'
import type { ServerOptions, ServerSite, ServerVersion } from '../types.ts'

export function restartOptions(
  deps: () => Deps
): (site: ServerSite, version: ServerVersion) => Promise<ServerOptions | null> {
  return async (site, version) => {
    const d = deps()
    const record = await d.store.findSite(site.name)
    const v = record?.id === site.id ? await d.store.getVersion(record, version.id) : null
    if (!record || !v?.server) return null
    return (await optionsFor(d, record, v.server)).options
  }
}
