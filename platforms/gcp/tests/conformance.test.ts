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
import { beforeAll, describe, expect, it } from 'vitest'
import { GcsBlobs } from '../src/blobs/gcs.ts'
import { FirestoreTable, MAX_KEY_BYTES } from '../src/table/firestore.ts'
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

  it('refuses a key longer than Firestore indexes, and finds nothing under one', async () => {
    const long = 'é'.repeat(MAX_KEY_BYTES / 2 + 1)
    await expect(table().put({ pk: 'P#long', sk: long })).rejects.toThrow(/1500 bytes/)
    await expect(
      table().transact([{ put: { pk: long, sk: 'S' } }, { put: { pk: 'P#ok', sk: 'S' } }])
    ).rejects.toThrow(/1500 bytes/)
    expect(await table().get('P#ok', 'S')).toBeNull()
    expect((await table().query('P#long', { skPrefix: long })).items).toEqual([])
  })

  it('takes a patch that names the key, and leaves the item where it is', async () => {
    await table().put({ pk: 'P#patch', sk: 'S', n: 1 })
    const next = await table().update('P#patch', 'S', { set: { pk: 'X', sk: 'Y', n: 2 } })
    expect(next).toEqual({ pk: 'P#patch', sk: 'S', n: 2 })
    expect(await table().get('X', 'Y')).toBeNull()
  })

  it('refuses a limit that is not a positive whole number', async () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(table().query('P#limit', { limit })).rejects.toThrow(/limit/)
      await expect(table().scan({ limit })).rejects.toThrow(/limit/)
    }
  })
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

  it('signs a download as an attachment, so the store never renders a site file', async () => {
    const url = new URL(await new GcsBlobs(gcs.bucket, gcs.storage).presignGet('sites/a.html'))
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment')
  })
})
