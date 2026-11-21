/**
 * The Node host (src/host.ts) beyond the e2e: routing by host, the web UI's files and headers, the
 * sites host's files and headers, the tick and migrate endpoints behind their caller check, and
 * the live rooms over real WebSockets, alone and spread over two hosts through the Postgres
 * fan-out (on PGlite here, on a Postgres server where FLING_TEST_POSTGRES_URL is set).
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { FsBlobs } from '@fling/api/blobs/fs'
import { type Config, loadBaseConfig } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import { type Admission, signTicket } from '@fling/api/live'
import { type LiveFanout, MemoryLiveHub } from '@fling/api/live-memory'
import { TableRouteTable } from '@fling/api/route-table/table'
import { Records } from '@fling/api/store/records'
import { type LiveHubClient, liveHubConformance, routeTableConformance } from '@fling/conformance'
import type { LiveServerMessage } from '@fling/shared'
import { siteKvsKey } from '@fling/shared/route-keys'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createNodeHost, type NodeHost, sharedSecretTicks, TICK_PATHS } from '../src/host.ts'
import { PostgresFanout, pgliteNotifier, pgNotifier } from '../src/live/postgres-fanout.ts'
import { CachedRouteTable } from '../src/route-table/cached.ts'
import { PostgresTable } from '../src/table/postgres.ts'
import { migrateSchema } from '../src/table/schema.ts'
import { pgliteClient } from '../src/table/sql.ts'
import { POSTGRES_URL } from './services.ts'

const APP = 'http://app.example.test'
const SECRET = 's'.repeat(40)
const TICKS = 't'.repeat(40)

const closing: (() => Promise<unknown> | unknown)[] = []
afterAll(async () => {
  for (const close of closing.reverse()) await close()
})

/** The web build a deploy ships: the UI, and the sites' pages. */
function webBuild() {
  const dir = mkdtempSync(join(tmpdir(), 'fling-web-'))
  mkdirSync(join(dir, 'dist', 'assets'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><title>Fling</title>')
  writeFileSync(join(dir, 'dist', 'assets', 'index-Bk3x9a2Q.js'), 'console.log(1)')
  writeFileSync(join(dir, 'dist', 'logo.svg'), '<svg/>')
  writeFileSync(join(dir, '404.html'), '<p>missing, back to __APP_ORIGIN__</p>')
  writeFileSync(join(dir, 'review.html'), '<p>review</p>')
  writeFileSync(join(dir, 'robots.txt'), 'User-agent: *\nDisallow: /\n')
  return dir
}

async function world(opts: { live?: MemoryLiveHub; db?: PGlite } = {}) {
  const db = pgliteClient(opts.db ?? (await PGlite.create()))
  if (!opts.db) closing.push(() => db.close())
  const schema = `h_${randomBytes(4).toString('hex')}`
  await migrateSchema(db, schema)
  const table = new PostgresTable(db, { schema })
  const fsRoot = mkdtempSync(join(tmpdir(), 'fling-node-host-'))
  const base = loadBaseConfig({
    APP_ORIGIN: APP,
    SITES_DOMAIN: 'sites.example.test',
    SITE_SCHEME: 'http',
    LIVE_URL: 'ws://app.example.test/api/live',
  })
  const config: Config = {
    ...base,
    secrets: { sessionSecret: SECRET, siteHmacKey: 'h'.repeat(40) },
  }
  const live = opts.live ?? new MemoryLiveHub()
  const routes = new CachedRouteTable(new TableRouteTable(table))
  const blobs = new FsBlobs(fsRoot, APP, SECRET)
  const deps = buildDeps(config, { store: new Records(table), blobs, routeTable: routes, live })
  const web = webBuild()
  const host = createNodeHost({
    deps,
    table,
    uiDir: join(web, 'dist'),
    pages: {
      notFound: join(web, '404.html'),
      reviewShell: join(web, 'review.html'),
      robots: join(web, 'robots.txt'),
    },
    live,
    ticks: { authorize: sharedSecretTicks(TICKS) },
  })
  return { host, deps, routes, blobs, live, table }
}

const get = (host: NodeHost, url: string, init: RequestInit = {}) =>
  host.fetch(new Request(url, init))

describe('the Node host', () => {
  it('answers the API and the UI on the app host, and nothing on other hosts', async () => {
    const { host } = await world()
    const health = await get(host, `${APP}/healthz`)
    expect(health.status).toBe(200)
    const route = await get(host, `${APP}/sites/hello`)
    expect(route.status).toBe(200)
    expect(await route.text()).toContain('<title>Fling</title>')
    expect(route.headers.get('cache-control')).toBe('no-cache')
    expect(route.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(route.headers.get('strict-transport-security')).toBeNull()
    const asset = await get(host, `${APP}/assets/index-Bk3x9a2Q.js`)
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(asset.headers.get('content-type')).toMatch(/javascript/)
    expect((await get(host, `${APP}/assets/gone-Zz9y8x7W.js`)).status).toBe(404)
    expect((await get(host, `${APP}/logo.svg`)).headers.get('cache-control')).toBe(
      'public, max-age=300'
    )
    expect((await get(host, `${APP}/..%2F..%2Fetc/passwd`)).status).not.toBe(500)
    expect((await get(host, 'http://elsewhere.example.test/healthz')).status).toBe(404)
  })

  it('serves a site file from Blobs with its headers, revalidates, and 404s the rest', async () => {
    const { host, routes, blobs } = await world()
    await routes.put(
      siteKvsKey('pub'),
      JSON.stringify({ id: 'S1', v: 'V1', vis: 'public', spa: false })
    )
    await blobs.put('sites/S1/V1/index.html', new TextEncoder().encode('<h1>hi</h1>'))
    const res = await get(host, 'http://pub.sites.example.test/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>hi</h1>')
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=0, must-revalidate, s-maxage=31536000'
    )
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    expect(res.headers.get('x-fling-version')).toBe('V1')
    const etag = res.headers.get('etag') as string
    const again = await get(host, 'http://pub.sites.example.test/', {
      headers: { 'if-none-match': etag },
    })
    expect(again.status).toBe(304)
    const missing = await get(host, 'http://pub.sites.example.test/nope.html')
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe(`<p>missing, back to ${APP}</p>`)
    expect(missing.headers.get('cache-control')).toBe('no-store')
    expect(missing.headers.get('x-robots-tag')).toBe('noindex')
    const robots = await get(host, 'http://pub.sites.example.test/robots.txt')
    expect(await robots.text()).toContain('Disallow: /')
    expect((await get(host, 'http://unknown.sites.example.test/')).status).toBe(404)
  })

  it('runs the ticks and migrations only for a caller with the secret', async () => {
    const { host } = await world()
    const tick = (path: string, auth?: string) =>
      get(host, `${APP}${path}`, {
        method: 'POST',
        ...(auth ? { headers: { authorization: auth } } : {}),
      })
    for (const path of Object.values(TICK_PATHS)) {
      expect((await tick(path)).status).toBe(404)
      expect((await tick(path, `Bearer ${'x'.repeat(40)}`)).status).toBe(404)
    }
    expect(await (await tick(TICK_PATHS.notify, `Bearer ${TICKS}`)).json()).toEqual({ mail: false })
    expect(await (await tick(TICK_PATHS.maintain, `Bearer ${TICKS}`)).json()).toMatchObject({
      partial: false,
      revocations: 0,
      purged: 0,
    })
    expect(await (await tick(TICK_PATHS.migrate, `Bearer ${TICKS}`)).json()).toMatchObject({
      done: true,
    })
    expect((await get(host, `${APP}${TICK_PATHS.notify}`)).status).toBe(404)
  })
})

describe('CachedRouteTable', () => {
  routeTableConformance('CachedRouteTable over the Table', async () => {
    const db = pgliteClient(await PGlite.create())
    closing.push(() => db.close())
    await migrateSchema(db)
    return new CachedRouteTable(new TableRouteTable(new PostgresTable(db)))
  })

  it('sees a new key at once, and another writer’s change within its ttl', async () => {
    const db = pgliteClient(await PGlite.create())
    closing.push(() => db.close())
    await migrateSchema(db)
    const source = new TableRouteTable(new PostgresTable(db))
    let now = 0
    const cached = new CachedRouteTable(source, { ttlMs: 5_000, now: () => now })
    expect(await cached.get('site:a')).toBeUndefined()
    await source.put('site:a', '1')
    expect(await cached.get('site:a')).toBe('1')
    await source.put('site:a', '2')
    expect(await cached.get('site:a')).toBe('1')
    now += 5_001
    expect(await cached.get('site:a')).toBe('2')
  })
})

/** A live socket to a listening host, as a browser opens it. */
async function socketTo(port: number, admission: Admission): Promise<LiveHubClient> {
  const ticket = signTicket(SECRET, admission, new Date(Date.now() + 60_000))
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live?ticket=${encodeURIComponent(ticket)}`, {
    headers: { host: 'app.example.test' },
  })
  const got: LiveServerMessage[] = []
  ws.on('message', data => void got.push(JSON.parse(String(data))))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return {
    got,
    send: async m => ws.send(JSON.stringify(m)),
    close: async () => {
      if (ws.readyState === WebSocket.OPEN) ws.close(1000)
    },
  }
}

/** Hosts listening on free ports; connections alternate between them; publish goes to the first. */
async function liveHosts(fanouts: (LiveFanout | undefined)[], db?: PGlite) {
  const hosts = await Promise.all(
    fanouts.map(async fanout => {
      const live = new MemoryLiveHub(fanout ? { fanout } : {})
      const w = await world({ live, ...(db ? { db } : {}) })
      const listening = await w.host.listen(0, '127.0.0.1')
      closing.push(() => listening.close())
      return { live, port: listening.port }
    })
  )
  let n = 0
  return {
    publish: (siteId: string, message: LiveServerMessage) =>
      (hosts[0] as { live: MemoryLiveHub }).live.publish(siteId, message),
    connect: (admission: Admission) =>
      socketTo((hosts[n++ % hosts.length] as { port: number }).port, admission),
  }
}

liveHubConformance('Node host (WebSockets, one process)', () => liveHosts([undefined]))

let shared: Promise<PGlite> | undefined
liveHubConformance('Node hosts sharing a PGlite (Postgres LISTEN/NOTIFY)', async () => {
  shared ??= PGlite.create().then(db => {
    closing.push(() => db.close())
    return db
  })
  const db = await shared
  const schema = `f_${randomBytes(4).toString('hex')}`
  return liveHosts(
    [0, 1].map(() => new PostgresFanout(pgliteNotifier(db), { schema })),
    db
  )
})

describe.runIf(POSTGRES_URL)('Postgres server', () => {
  liveHubConformance('Node hosts sharing a Postgres server (LISTEN/NOTIFY)', async () => {
    const schema = `f_${randomBytes(4).toString('hex')}`
    const pools = [0, 1].map(() => new pg.Pool({ connectionString: POSTGRES_URL, max: 4 }))
    const fanouts = pools.map(pool => new PostgresFanout(pgNotifier(pool), { schema }))
    closing.push(async () => {
      for (const f of fanouts) await f.close()
      for (const p of pools) await p.end()
    })
    return liveHosts(fanouts)
  })
})

it('refuses a live socket without a good ticket, or on another host', async () => {
  const { host } = await world()
  const listening = await host.listen(0, '127.0.0.1')
  closing.push(() => listening.close())
  const refused = (url: string, hostHeader: string) =>
    new Promise<number>(resolve => {
      const ws = new WebSocket(url, { headers: { host: hostHeader } })
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('open', () => resolve(101))
      ws.on('error', () => {})
    })
  const base = `ws://127.0.0.1:${listening.port}/api/live`
  expect(await refused(`${base}?ticket=nope`, 'app.example.test')).toBe(401)
  const ticket = signTicket(
    SECRET,
    { siteId: 'S', siteName: 'hello', name: 'A', colour: 'red' },
    new Date(Date.now() + 60_000)
  )
  expect(await refused(`${base}?ticket=${ticket}`, 'pub.sites.example.test')).toBe(401)
})
