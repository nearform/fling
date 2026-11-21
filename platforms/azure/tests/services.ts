/**
 * Clients for the local stand-ins the service-backed suites run against: the Cosmos DB Linux
 * emulator (vNext) and Azurite. Each suite runs only when its endpoint env var is set (CI sets both,
 * with the services in ci.yml), so `pnpm gate` passes on a laptop without Docker. To run them
 * locally:
 *
 *   docker run -d -p 8081:8081 mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator:vnext-preview
 *   docker run -d -p 10000:10000 mcr.microsoft.com/azure-storage/azurite azurite-blob --blobHost 0.0.0.0
 *   FLING_TEST_COSMOS_ENDPOINT=http://localhost:8081 \
 *     FLING_TEST_AZURITE_ENDPOINT=http://127.0.0.1:10000/devstoreaccount1 \
 *     pnpm --filter @fling/platform-azure test
 *
 * Both emulators take the well-known development keys below, published by Microsoft for them and
 * nothing else. The databases, containers and blob containers are created here, named per run.
 */
import { randomUUID } from 'node:crypto'
import { CosmosClient } from '@azure/cosmos'
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob'
import { PARTITION_KEY_PATH } from '../src/table/cosmos.ts'

export const COSMOS_ENDPOINT = process.env.FLING_TEST_COSMOS_ENDPOINT
export const AZURITE_ENDPOINT = process.env.FLING_TEST_AZURITE_ENDPOINT

/** The Cosmos DB emulator's published key. */
const COSMOS_EMULATOR_KEY =
  'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw=='
/** Azurite's published account and key. */
const AZURITE_ACCOUNT = 'devstoreaccount1'
const AZURITE_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='

const run = randomUUID().slice(0, 8)
let containers = 0

/** The container settings infra/data.tf gives the instance's container. */
export const CONTAINER_SETTINGS = {
  partitionKey: { paths: [PARTITION_KEY_PATH] },
  defaultTtl: -1,
  indexingPolicy: {
    indexingMode: 'consistent' as const,
    includedPaths: [{ path: '/*' }],
    excludedPaths: [{ path: '/j/?' }, { path: '/"_etag"/?' }],
    // As infra/data.tf: what query's ORDER BY c.pk, c.skx needs.
    compositeIndexes: [
      [
        { path: '/pk', order: 'ascending' as const },
        { path: '/skx', order: 'ascending' as const },
      ],
      [
        { path: '/pk', order: 'ascending' as const },
        { path: '/skx', order: 'descending' as const },
      ],
    ],
  },
}

let client: CosmosClient | undefined

/** The emulator takes a while to start (a CI service container is up before it listens). */
async function ready<T>(attempt: () => Promise<T>, ms = 90_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    try {
      return await attempt()
    } catch (err) {
      if (Date.now() > until) throw err
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
  }
}

/** A fresh container on the emulator, with the instance's settings. */
export async function cosmosContainer() {
  client ??= new CosmosClient({ endpoint: COSMOS_ENDPOINT as string, key: COSMOS_EMULATOR_KEY })
  const { database } = await ready(() =>
    (client as CosmosClient).databases.createIfNotExists({ id: `fling-${run}` })
  )
  const { container } = await database.containers.createIfNotExists({
    id: `items-${containers++}`,
    ...CONTAINER_SETTINGS,
  })
  return container
}

/** An Azurite blob container, with a client signing by account key (as the emulator needs). */
export async function azuriteContainer() {
  const credential = new StorageSharedKeyCredential(AZURITE_ACCOUNT, AZURITE_KEY)
  const service = new BlobServiceClient(AZURITE_ENDPOINT as string, credential)
  const container = service.getContainerClient(`fling-${run}-${containers++}`)
  await ready(() => container.createIfNotExists())
  return { service, container, credential }
}
