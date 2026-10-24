/**
 * The conformance suites against the Cloudflare adapters on Miniflare (see miniflare.ts): D1Table
 * and Records on it, the data migrations on D1, R2Blobs with its signed-upload route, and the KV
 * route table. Nothing external is needed, so these run in every `pnpm gate`.
 */
import { Records } from '@fling/api/store/records'
import {
  blobsConformance,
  migrationsConformance,
  routeTableConformance,
  storeConformance,
  tableConformance,
} from '@fling/conformance'
import { afterAll, beforeAll } from 'vitest'
import { R2Blobs } from '../src/blobs/r2.ts'
import { WorkersKvRouteTable } from '../src/route-table/kv.ts'
import { D1Table } from '../src/table/d1.ts'
import { type Local, local } from './miniflare.ts'

const APP_ORIGIN = 'https://app.example.test'

let cf: Local
beforeAll(async () => {
  cf = await local()
}, 60_000)
afterAll(() => cf?.mf.dispose())

tableConformance('D1Table', () => new D1Table(cf.db))

storeConformance('Records on D1Table', () => new Records(new D1Table(cf.db)))

// Migrations scan the whole table: an empty database per test.
migrationsConformance('D1Table', async () => new D1Table(await cf.freshDb()))

routeTableConformance('WorkersKvRouteTable', () => new WorkersKvRouteTable(cf.kv))

// Uploads are real requests to the route in tests/worker.ts, which streams them into R2.
blobsConformance('R2Blobs', () => ({
  blobs: new R2Blobs(cf.bucket, { secret: cf.uploadSecret, baseUrl: APP_ORIGIN }),
  upload: async (url, init) =>
    (await cf.mf.dispatchFetch(url, init as never)) as unknown as Response,
}))
