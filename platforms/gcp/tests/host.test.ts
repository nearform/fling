/**
 * The GCP host's own wiring (the Node host itself is tested in platforms/node): the environment
 * and its secrets, the drivers, the tick endpoints behind the ID-token check, and the host's
 * upload routes for a client that sends no MD5. On the core's memory Table and fs Blobs, so it
 * runs in every `pnpm gate`.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsBlobs } from '@fling/api/blobs/fs'
import { MemoryTable } from '@fling/api/table/memory'
import { TICK_PATHS } from '@fling/platform-node/host'
import { afterAll, describe, expect, it } from 'vitest'
import { GCP_DRIVERS, gcpConfig, instanceFileEnv, tickServiceAccounts } from '../src/env.ts'
import { createGcpHost } from '../src/host.ts'

const APP = 'http://app.example.test'
const ENV = {
  APP_ORIGIN: APP,
  SITES_DOMAIN: 'sites.example.test',
  SITE_SCHEME: 'http',
  SITES_BUCKET: 'example-sites',
  SESSION_SECRET: 's'.repeat(40),
  SITE_HMAC_KEY: 'h'.repeat(40),
}

const closing: (() => Promise<unknown>)[] = []
afterAll(async () => {
  for (const close of closing) await close()
})

describe('the environment', () => {
  it('sets the GCP drivers, whatever the environment names', () => {
    const config = gcpConfig({ ...ENV, STORE_DRIVER: 'dynamo', STORAGE_DRIVER: 's3' })
    expect(config.storeDriver).toBe(GCP_DRIVERS.STORE_DRIVER)
    expect(config.storageDriver).toBe(GCP_DRIVERS.STORAGE_DRIVER)
    expect(config.kvsDriver).toBe(GCP_DRIVERS.KVS_DRIVER)
  })

  it('reads a secret still holding the placeholder as not set', () => {
    const config = gcpConfig({ ...ENV, OIDC_CLIENT_SECRET: 'unset', SMTP_PASSWORD: 'p4ss' })
    expect(config.secrets.oidcClientSecret).toBeUndefined()
    expect(config.secrets.smtpPassword).toBe('p4ss')
    expect(() => gcpConfig({ ...ENV, SESSION_SECRET: 'unset' })).toThrow(/SESSION_SECRET/)
  })

  it('needs the sites bucket, and refuses site servers', () => {
    const { SITES_BUCKET: _, ...withoutBucket } = ENV
    expect(() => gcpConfig(withoutBucket)).toThrow(/SITES_BUCKET/)
    expect(() => gcpConfig({ ...ENV, SERVERS: 'admins' })).toThrow(/SERVERS/)
  })

  it('reads instance.json under the environment, and the tick callers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fling-gcp-'))
    const file = join(dir, 'instance.json')
    writeFileSync(file, JSON.stringify({ INSTANCE_NAME: 'Example', INVITES_PER_DAY: 5 }))
    expect(instanceFileEnv(new URL(`file://${file}`))).toEqual({
      INSTANCE_NAME: 'Example',
      INVITES_PER_DAY: '5',
    })
    expect(instanceFileEnv(new URL(`file://${dir}/missing.json`))).toEqual({})
    expect(tickServiceAccounts({ TICK_SERVICE_ACCOUNTS: ' a@x.test, b@x.test ,' })).toEqual([
      'a@x.test',
      'b@x.test',
    ])
  })
})

async function gcpHost(opts: { authorize?: (r: Request) => boolean; live?: boolean } = {}) {
  const fsRoot = mkdtempSync(join(tmpdir(), 'fling-gcp-host-'))
  const config = gcpConfig({
    ...ENV,
    ...(opts.live ? { LIVE_URL: 'ws://app.example.test/api/live' } : {}),
  })
  const gcp = await createGcpHost({
    config,
    table: new MemoryTable(),
    blobs: () => new FsBlobs(fsRoot, APP, ENV.SESSION_SECRET),
    tickServiceAccounts: [],
    ...(opts.authorize ? { authorize: opts.authorize } : {}),
  })
  closing.push(() => gcp.close())
  const call = (path: string, init: RequestInit = {}) =>
    gcp.host.fetch(
      new Request(`${APP}${path}`, {
        ...init,
        headers: { host: 'app.example.test', ...init.headers },
      })
    )
  return { gcp, call }
}

describe('the GCP host', () => {
  it('publishes live only with LIVE_URL, and never site servers', async () => {
    for (const live of [false, true]) {
      const { call } = await gcpHost({ live })
      const meta = await (await call('/.well-known/fling')).json()
      expect(meta.capabilities.live).toBe(live)
      expect(meta.capabilities.servers).toBe(false)
    }
  })

  it('answers 404 on the tick endpoints without a caller check', async () => {
    const { call } = await gcpHost()
    for (const path of Object.values(TICK_PATHS)) {
      expect((await call(path, { method: 'POST' })).status).toBe(404)
    }
  })

  it('runs the ticks and the migrations for an authorised caller only', async () => {
    const { call } = await gcpHost({
      authorize: r => r.headers.get('authorization') === 'Bearer ok',
    })
    expect((await call(TICK_PATHS.migrate, { method: 'POST' })).status).toBe(404)
    const res = await call(TICK_PATHS.migrate, {
      method: 'POST',
      headers: { authorization: 'Bearer ok' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).done).toBe(true)
    const maintain = await call(TICK_PATHS.maintain, {
      method: 'POST',
      headers: { authorization: 'Bearer ok' },
    })
    expect(maintain.status).toBe(200)
  })

  it('serves the host upload routes, refusing an unsigned upload', async () => {
    const { call } = await gcpHost()
    const res = await call('/blob-upload/sites/x/index.html', { method: 'PUT', body: 'hi' })
    expect(res.status).toBe(403)
  })
})
