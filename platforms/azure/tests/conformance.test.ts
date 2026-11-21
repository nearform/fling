/**
 * The conformance suites against the Azure storage adapters: CosmosTable (and Records, the
 * migrations and the route table on it) on the Cosmos DB emulator, and AzureBlobs on Azurite, each
 * skipped unless its endpoint is configured (see services.ts).
 */
import { HostUploads } from '@fling/api/blobs/host-uploads'
import { TableRouteTable } from '@fling/api/route-table/table'
import { Records } from '@fling/api/store/records'
import {
  blobsConformance,
  migrationsConformance,
  routeTableConformance,
  storeConformance,
  tableConformance,
} from '@fling/conformance'
import { beforeAll, describe } from 'vitest'
import { AzureBlobs } from '../src/blobs/blob.ts'
import { CosmosTable } from '../src/table/cosmos.ts'
import { AZURITE_ENDPOINT, azuriteContainer, COSMOS_ENDPOINT, cosmosContainer } from './services.ts'

/** The platform's host, which serves HostUploads' routes. */
const HOST = 'https://app.example.test'

describe.runIf(COSMOS_ENDPOINT)('Cosmos DB emulator', () => {
  let shared: CosmosTable
  beforeAll(async () => {
    shared = new CosmosTable(await cosmosContainer())
  }, 120_000)
  tableConformance('CosmosTable', () => shared)
  storeConformance('Records on CosmosTable', () => new Records(shared))
  routeTableConformance('TableRouteTable on CosmosTable', () => new TableRouteTable(shared))
  // Migrations scan the whole table: a fresh container per test.
  migrationsConformance('CosmosTable', async () => new CosmosTable(await cosmosContainer()))
})

describe.runIf(AZURITE_ENDPOINT)('Azurite', () => {
  let azurite: Awaited<ReturnType<typeof azuriteContainer>>
  beforeAll(async () => {
    azurite = await azuriteContainer()
  }, 60_000)
  blobsConformance('AzureBlobs', () => {
    const blobs: AzureBlobs = new AzureBlobs(azurite.service, azurite.container, {
      uploads: { presignPut: (key, opts) => host.presignPut(key, opts) },
    })
    const host = new HostUploads(blobs, { secret: 'u'.repeat(40), baseUrl: HOST })
    return {
      blobs,
      upload: (url, init) =>
        url.startsWith(`${HOST}/`) ? host.handle(new Request(url, init)) : fetch(url, init),
      metadata: async key => {
        const props = await azurite.container.getBlockBlobClient(key).getProperties()
        return { contentType: props.contentType, cacheControl: props.cacheControl }
      },
    }
  })
})
