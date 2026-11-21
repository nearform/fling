/**
 * The conformance suites against the Google Cloud adapters: FirestoreTable (with Records and the
 * route table on it) on the Firestore emulator, and GcsBlobs on fake-gcs-server, each skipped
 * unless its endpoint is configured (see services.ts). fake-gcs-server checks no signature and no
 * Content-MD5, so the signed URLs go through Cloud Storage's own checks first (signed-urls.ts).
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
import { CachedRouteTable } from '@fling/platform-node/route-table/cached'
import type { Storage } from '@google-cloud/storage'
import { beforeAll, describe } from 'vitest'
import { GcsBlobs } from '../src/blobs/gcs.ts'
import { FirestoreTable } from '../src/table/firestore.ts'
import {
  FIRESTORE_EMULATOR_HOST,
  firestoreCollection,
  GCS_ENDPOINT,
  gcsBucket,
  SIGNING_KEY,
} from './services.ts'
import { verifyingStore } from './signed-urls.ts'

/** The platform's host, which serves HostUploads' routes. */
const HOST = 'https://app.example.test'

describe.runIf(FIRESTORE_EMULATOR_HOST)('Firestore emulator', () => {
  const shared = firestoreCollection()
  const table = () => new FirestoreTable(shared.db, { collection: shared.collection })
  tableConformance('FirestoreTable', table)
  storeConformance('Records on FirestoreTable', () => new Records(table()))
  // Migrations scan the whole table: a fresh collection per test.
  migrationsConformance('FirestoreTable', async () => {
    const fresh = firestoreCollection()
    return new FirestoreTable(fresh.db, { collection: fresh.collection })
  })
  routeTableConformance(
    'CachedRouteTable over TableRouteTable on FirestoreTable',
    () => new CachedRouteTable(new TableRouteTable(table()))
  )
})

describe.runIf(GCS_ENDPOINT)('fake-gcs-server', () => {
  let gcs: { storage: Storage; bucket: string }
  beforeAll(async () => {
    gcs = await gcsBucket()
  }, 60_000)
  const store = verifyingStore(SIGNING_KEY.publicKey)
  const metadata = async (key: string) => {
    const [meta] = await gcs.storage.bucket(gcs.bucket).file(key).getMetadata()
    return { contentType: meta.contentType, cacheControl: meta.cacheControl }
  }
  // A file sent without its MD5 goes through the host, which checks the SHA-256 itself.
  blobsConformance('GcsBlobs', () => {
    const host = new HostUploads(new GcsBlobs(gcs.bucket, gcs.storage), {
      secret: 'u'.repeat(40),
      baseUrl: HOST,
    })
    return {
      blobs: new GcsBlobs(gcs.bucket, gcs.storage, { fallback: host }),
      upload: (url, init) =>
        url.startsWith(`${HOST}/`) ? host.handle(new Request(url, init)) : store(url, init),
      download: url => store(url),
      metadata,
    }
  })
})
