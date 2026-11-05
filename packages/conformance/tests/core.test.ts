/**
 * The suites against the core's own adapters (memory table and Records on it, fs blobs, memory
 * route table). They run here rather than in apps/api so @fling/api doesn't depend on this package
 * (a cycle).
 * Presigned uploads and downloads go through the real app, whose `/dev-upload/*` and
 * `/dev-download/*` routes are FsBlobs' signed PUT and GET.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '@fling/api/app'
import { FsBlobs } from '@fling/api/blobs/fs'
import { loadBaseConfig } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import type { MailResult } from '@fling/api/mail'
import { FileMailer } from '@fling/api/mail/file'
import { MemoryMailer } from '@fling/api/mail/memory'
import { MemoryRouteTable } from '@fling/api/route-table/memory'
import { TableRouteTable } from '@fling/api/route-table/table'
import { Records } from '@fling/api/store/records'
import { FileTable } from '@fling/api/table/file'
import { MemoryTable } from '@fling/api/table/memory'
import {
  blobsConformance,
  EXPECTED_FAILURE,
  mailerConformance,
  migrationsConformance,
  routeTableConformance,
  storeConformance,
  tableConformance,
} from '../src/index.ts'

const APP_ORIGIN = 'https://app.example.test'

tableConformance('MemoryTable', () => new MemoryTable())

storeConformance('Records on MemoryTable', () => new Records(new MemoryTable()))

/** A FileTable on a new file, and a second one loading what the first saved: dev's restart. */
const fileTable = () =>
  new FileTable(join(mkdtempSync(join(tmpdir(), 'fling-table-')), 'table.json'))

tableConformance('FileTable', fileTable)

tableConformance('FileTable reloaded', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'fling-table-')), 'table.json')
  const first = new FileTable(file)
  return new Proxy(first, {
    // every read goes to a fresh FileTable on the same file, so what passes was saved
    get(target, prop) {
      if (prop === 'get' || prop === 'query' || prop === 'scan') {
        const reloaded = new FileTable(file)
        const method = reloaded[prop as 'get'] as (...args: unknown[]) => unknown
        return method.bind(reloaded)
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
})

storeConformance('Records on FileTable', () => new Records(fileTable()))

migrationsConformance('MemoryTable', async () => new MemoryTable())

routeTableConformance('MemoryRouteTable', () => new MemoryRouteTable())

routeTableConformance(
  'TableRouteTable on MemoryTable',
  () => new TableRouteTable(new MemoryTable())
)

blobsConformance('FsBlobs', () => {
  const root = mkdtempSync(join(tmpdir(), 'fling-conformance-'))
  const config = {
    ...loadBaseConfig({ APP_ORIGIN }),
    secrets: {
      sessionSecret: 's'.repeat(40),
      siteHmacKey: 'h'.repeat(40),
    },
  }
  const blobs = new FsBlobs(root, APP_ORIGIN, config.secrets.sessionSecret)
  const app = createApp(buildDeps(config, { blobs }))
  return {
    blobs,
    upload: (url, init) => Promise.resolve(app.request(url, init)),
    download: url => Promise.resolve(app.request(url)),
  }
})

mailerConformance(
  'MemoryMailer',
  () => {
    const mailer = new MemoryMailer()
    return {
      mailer,
      delivered: async () =>
        mailer.sent.map(({ message }) => ({
          to: message.to,
          subject: message.subject,
          from: message.from,
          headers: message.headers,
        })),
    }
  },
  {
    // MemoryMailer has no provider: its scripted results stand in for one.
    failing: failure => {
      const mailer = new MemoryMailer()
      mailer.failNext(EXPECTED_FAILURE[failure] as Extract<MailResult, { ok: false }>)
      return mailer
    },
  }
)

mailerConformance('FileMailer', () => {
  const mailer = new FileMailer(join(mkdtempSync(join(tmpdir(), 'fling-mail-')), 'mail'))
  return {
    mailer,
    delivered: async () =>
      (await mailer.list()).map(({ to, subject, from, headers }) => ({
        to,
        subject,
        from,
        headers,
      })),
  }
})
