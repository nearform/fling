/**
 * The Container App's HTTP handler: the Node host (platforms/node, createNodeHost) with the Azure
 * deps, behind Front Door's check (front-door.ts), plus the Web PubSub hub's event handler on the
 * app host (live.ts). There are no tick endpoints: the ticks and migrations run as Container Apps
 * jobs in their own process (main.ts), so nothing outside can start one.
 */
import { createNodeHost, type PageFiles } from '@fling/platform-node/host'
import type { AzureDeps } from './deps.ts'
import { behindFrontDoor } from './front-door.ts'
import { handleLiveEvents, LIVE_EVENTS_PATH } from './live.ts'
import type { AzureSettings } from './settings.ts'

export interface AzureHostOptions {
  azure: AzureDeps
  settings: Pick<AzureSettings, 'webPubSub'>
  /** the web UI's build (apps/web/dist) */
  uiDir?: string
  pages?: Partial<PageFiles>
  maxBodyBytes?: number
}

export function createAzureHost(opts: AzureHostOptions) {
  const { deps, table, uploads, live } = opts.azure
  const { config } = deps
  const node = createNodeHost({
    deps,
    table,
    uploads,
    ...(opts.uiDir ? { uiDir: opts.uiDir } : {}),
    ...(opts.pages ? { pages: opts.pages } : {}),
    ...(opts.maxBodyBytes ? { maxBodyBytes: opts.maxBodyBytes } : {}),
  })
  const appHost = new URL(config.appOrigin).hostname.toLowerCase()
  const pubsub = opts.settings.webPubSub
  const route = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const host = (request.headers.get('host') ?? url.host).toLowerCase().replace(/:\d+$/, '')
    if (host === appHost && url.pathname === LIVE_EVENTS_PATH) {
      if (!live || !pubsub) return new Response('Not found', { status: 404 })
      return handleLiveEvents(request, deps, live, {
        secret: pubsub.eventsSecret,
        endpoint: pubsub.endpoint,
        hub: pubsub.hub,
      })
    }
    return node.fetch(request)
  }
  return {
    fetch: behindFrontDoor(route, {
      ...(config.secrets.originVerifySecret ? { secret: config.secrets.originVerifySecret } : {}),
      allowMissing: config.appEnv === 'development',
      sitesDomain: config.sitesDomain,
    }),
  }
}
