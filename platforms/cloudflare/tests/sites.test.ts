/**
 * The Worker's sites host beyond the e2e: the route table's KV-miss fallback, and serving files
 * from R2 the way the AWS sites distribution does (stored headers, ETag revalidation, ranges, HEAD,
 * the 404 page, the review shell). R2, KV and D1 are Miniflare's (tests/miniflare.ts).
 */
import { TableRouteTable } from '@fling/api/route-table/table'
import { routeTableConformance } from '@fling/conformance'
import { siteKvsKey } from '@fling/shared/route-keys'
import { signSiteCookie } from '@fling/shared/site-cookie'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CachedRouteTable } from '../src/route-table/cached.ts'
import { WorkersKvRouteTable } from '../src/route-table/kv.ts'
import { D1Table } from '../src/table/d1.ts'
import { type Local, local } from './miniflare.ts'

let cf: Local
beforeAll(async () => {
  cf = await local()
}, 60_000)
afterAll(() => cf?.mf.dispose())

const routes = () =>
  new CachedRouteTable(new WorkersKvRouteTable(cf.kv), new TableRouteTable(new D1Table(cf.db)))

routeTableConformance('CachedRouteTable (KV over D1)', routes)

describe('CachedRouteTable', () => {
  it('answers a KV miss from the table, and writes the table first', async () => {
    const source = new TableRouteTable(new D1Table(cf.db))
    const table = new CachedRouteTable(new WorkersKvRouteTable(cf.kv), source)
    const key = `site:fallback-${crypto.randomUUID()}`
    await source.put(key, 'from-d1') // as if KV had not caught up
    expect(await table.get(key)).toBe('from-d1')
    await table.put(key, 'both')
    expect(await cf.kv.get(key)).toBe('both')
    expect(await source.get(key)).toBe('both')
    await table.delete(key)
    expect(await table.get(key)).toBeUndefined()
  })
})

describe('the sites host (src/sites.ts, in workerd)', () => {
  const APP = 'https://app.example.test'
  const html = '<!doctype html><title>hi</title>'

  beforeAll(async () => {
    const table = routes()
    await table.put(
      siteKvsKey('pub'),
      JSON.stringify({ id: 'S1', v: 'V1', vis: 'public', spa: false })
    )
    await table.put(
      siteKvsKey('priv'),
      JSON.stringify({ id: 'S2', v: 'V2', vis: 'private', spa: true })
    )
    await cf.bucket.put('sites/S1/V1/index.html', html, {
      httpMetadata: {
        contentType: 'text/html',
        cacheControl: 'public, max-age=0, must-revalidate',
      },
    })
    await cf.bucket.put('sites/S1/V1/a b.txt', '0123456789', {
      httpMetadata: { contentType: 'text/plain' },
    })
    await cf.bucket.put('sites/S2/V2/index.html', 'private app', {
      httpMetadata: { contentType: 'text/html' },
    })
  })

  const req = async (host: string, path = '/', init: RequestInit = {}) =>
    (await cf.mf.dispatchFetch(`https://${host}${path}`, {
      redirect: 'manual',
      ...init,
    } as never)) as unknown as Response

  it('serves a file with its stored headers and an ETag; revalidates to 304', async () => {
    const res = await req('pub.sites.example.test')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(html)
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    const etag = res.headers.get('etag')
    expect(etag).toBeTruthy()
    const again = await req('pub.sites.example.test', '/', {
      headers: { 'if-none-match': etag as string },
    })
    expect(again.status).toBe(304)
  })

  it('decodes the path into the object key; serves ranges and HEAD', async () => {
    const range = await req('pub.sites.example.test', '/a%20b.txt', {
      headers: { range: 'bytes=2-4' },
    })
    expect(range.status).toBe(206)
    expect(await range.text()).toBe('234')
    expect(range.headers.get('content-range')).toBe('bytes 2-4/10')
    const head = await req('pub.sites.example.test', '/a%20b.txt', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('10')
    expect(await head.text()).toBe('')
  })

  it('answers unknown hosts and missing files with the 404 page, never cached', async () => {
    for (const [host, path] of [
      ['nope.sites.example.test', '/'],
      ['pub.sites.example.test', '/missing.html'],
      ['pub.sites.example.test', '/%E0%A4%A.html'],
    ] as const) {
      const res = await req(host, path)
      expect(res.status).toBe(404)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.text()).toBe(`<p>404 for ${APP}</p>`)
    }
  })

  it('serves the review shell on any site host, filled in, frameable and revalidated', async () => {
    for (const host of ['priv.sites.example.test', 'nope.sites.example.test']) {
      const res = await req(host, '/_fling/review.html?path=%2F')
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-cache')
      expect(res.headers.get('x-frame-options')).toBeNull()
      expect(res.headers.get('content-security-policy')).toBeNull()
      expect(await res.text()).toBe(`<p>shell for ${APP}</p>`)
    }
  })

  it('sends private sites to sign in, and serves them with a valid cookie', async () => {
    const anon = await req('priv.sites.example.test', '/x?y=1')
    expect(anon.status).toBe(302)
    expect(anon.headers.get('location')).toBe(
      `${APP}/auth/login?return=${encodeURIComponent('https://priv.sites.example.test/x?y=1')}`
    )
    const cookie = signSiteCookie({ e: 'a@example.test', x: Date.now() / 1000 + 60 }, cf.siteKey)
    const member = await req('priv.sites.example.test', '/deep/link', {
      headers: { cookie: `other=1; fling_site=${cookie}` },
    })
    expect(member.status).toBe(200)
    expect(await member.text()).toBe('private app')
  })

  it('refuses other methods', async () => {
    const res = await req('pub.sites.example.test', '/', { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
  })
})
