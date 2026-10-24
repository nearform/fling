/**
 * The suites against the core's own adapters (memory table and store, fs blobs, memory route
 * table). They run here rather than in apps/api so @fling/api doesn't depend on this package (a
 * cycle).
 * Presigned uploads go through the real app, whose `/dev-upload/*` route is FsBlobs' signed PUT.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '@fling/api/app'
import { FsBlobs } from '@fling/api/blobs/fs'
import { loadBaseConfig } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import { MemoryRouteTable } from '@fling/api/route-table/memory'
import { MemoryStore } from '@fling/api/store/memory'
import { MemoryTable } from '@fling/api/table/memory'
import {
  blobsConformance,
  routeTableConformance,
  storeConformance,
  tableConformance,
} from '../src/index.ts'

const APP_ORIGIN = 'https://app.example.test'

tableConformance('MemoryTable', () => new MemoryTable())

storeConformance('MemoryStore', () => new MemoryStore())

routeTableConformance('MemoryRouteTable', () => new MemoryRouteTable())

blobsConformance('FsBlobs', () => {
  const root = mkdtempSync(join(tmpdir(), 'fling-conformance-'))
  const config = {
    ...loadBaseConfig({ APP_ORIGIN }),
    secrets: {
      googleClientId: '',
      googleClientSecret: '',
      sessionSecret: 's'.repeat(40),
      siteHmacKey: 'h'.repeat(40),
    },
  }
  const blobs = new FsBlobs(root, APP_ORIGIN, config.secrets.sessionSecret)
  const app = createApp(buildDeps(config, { blobs }))
  return { blobs, upload: (url, init) => Promise.resolve(app.request(url, init)) }
})
