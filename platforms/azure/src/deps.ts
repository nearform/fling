/**
 * The Azure adapters, wired into the core's deps: CosmosTable (and the route table on it, cached
 * per process), AzureBlobs with the host's upload routes, the Web PubSub live hub (with live
 * rooms) and AcsMailer (with MAIL_DRIVER=acs). Every service is reached with one credential, the
 * host's managed identity in production (DefaultAzureCredential, src/main.ts). The clients are
 * passed in, so tests build the same deps over emulators and fakes.
 */
import type { Container } from '@azure/cosmos'
import type { BlobServiceClient } from '@azure/storage-blob'
import { HostUploads } from '@fling/api/blobs/host-uploads'
import type { Config } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import { TableRouteTable } from '@fling/api/route-table/table'
import { Records } from '@fling/api/store/records'
import type { Deps } from '@fling/api/types'
import { CachedRouteTable } from '@fling/platform-node/route-table/cached'
import { AzureBlobs } from './blobs/blob.ts'
import { type PubSubConnections, WebPubSubLiveHub } from './live.ts'
import { type AcsClient, AcsMailer } from './mail/acs.ts'
import { CosmosTable } from './table/cosmos.ts'

/** The drivers this platform implements, whatever the environment names. */
export const AZURE_DRIVERS = {
  STORE_DRIVER: 'cosmos',
  STORAGE_DRIVER: 'azure-blob',
  KVS_DRIVER: 'table',
} as const

export interface AzureClients {
  container: Container
  blobService: BlobServiceClient
  sitesContainer: string
  /** with live rooms */
  pubsub?: PubSubConnections
  /** with MAIL_DRIVER=acs */
  email?: AcsClient
}

export interface AzureDeps {
  deps: Deps
  table: CosmosTable
  uploads: HostUploads
  live?: WebPubSubLiveHub
}

export function buildAzureDeps(config: Config, clients: AzureClients): AzureDeps {
  if (config.servers.publish.kind !== 'off') {
    throw new Error('SERVERS must be off on Azure: site servers are not built for it yet')
  }
  const table = new CosmosTable(clients.container)
  const store = new Records(table)
  // The uploads route writes through the blobs, and the blobs presign through the route.
  let uploads: HostUploads | undefined
  const blobs = new AzureBlobs(
    clients.blobService,
    clients.blobService.getContainerClient(clients.sitesContainer),
    { uploads: { presignPut: (key, opts) => (uploads as HostUploads).presignPut(key, opts) } }
  )
  uploads = new HostUploads(blobs, {
    secret: config.secrets.sessionSecret,
    baseUrl: config.appOrigin,
  })
  const live =
    config.live && clients.pubsub ? new WebPubSubLiveHub(store, clients.pubsub) : undefined
  if (config.live && !live) throw new Error('Live rooms need Web PubSub (WEB_PUBSUB_ENDPOINT)')
  const mailer =
    config.mail?.driver === 'acs' && clients.email ? new AcsMailer(clients.email) : undefined
  if (config.mail?.driver === 'acs' && !mailer)
    throw new Error('MAIL_DRIVER=acs needs ACS_ENDPOINT')
  const deps = buildDeps(config, {
    store,
    blobs,
    routeTable: new CachedRouteTable(new TableRouteTable(table)),
    ...(live ? { live } : {}),
    ...(mailer ? { mailer } : {}),
  })
  return { deps, table, uploads, ...(live ? { live } : {}) }
}
