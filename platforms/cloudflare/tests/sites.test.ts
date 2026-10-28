/**
 * The Worker's sites host beyond the e2e: the route table's KV-miss fallback, and serving files
 * from R2 the way the AWS sites distribution does (stored headers, ETag revalidation, ranges, HEAD,
 * the 404 page, the review shell), robots.txt and the headers every sites host adds. R2, KV and D1 are Miniflare's (tests/miniflare.ts).
 */
import { TableRouteTable } from '@fling/api/route-table/table'
import { routeTableConformance } from '@fling/conformance'
import { shareKvsKey, siteKvsKey } from '@fling/shared/route-keys'
import { signDenyHandoff, signPassHandoff, signSiteCookie } from '@fling/shared/site-cookie'
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
  const TOKEN = 'abcdefghij0123456789'
  const SHARE = `s--${TOKEN}.sites.example.test`

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
    await table.put(
      shareKvsKey(TOKEN),
      JSON.stringify({ id: 'S1', v: 'V1', vis: 'private', spa: false })
    )
    await table.put(
      siteKvsKey('team'),
      JSON.stringify({ id: 'S3', v: 'V3', vis: 'private', spa: false, r: 1 })
    )
    await cf.bucket.put('sites/S3/V3/index.html', 'team app', {
      httpMetadata: { contentType: 'text/html' },
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

  it('lets a restricted site in only with its site pass, set from a handoff', async () => {
    const member = signSiteCookie({ e: 'a@example.test', x: Date.now() / 1000 + 60 }, cf.siteKey)
    const refused = await req('team.sites.example.test', '/', {
      headers: { cookie: `fling_site=${member}` },
    })
    expect(refused.status).toBe(302)
    const t = signPassHandoff(
      { s: 'S3', e: 'a@example.test', x: Math.floor(Date.now() / 1000) + 60 },
      cf.siteKey
    )
    const pass = await req('team.sites.example.test', `/_fling-pass?t=${t}&r=%2Fdocs%2F`)
    expect(pass.status).toBe(302)
    expect(pass.headers.get('location')).toBe('/docs/')
    const setCookie = pass.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(
      /^fling_pass=[^;]+; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=300$/
    )
    const served = await req('team.sites.example.test', '/', {
      headers: { cookie: setCookie.split(';')[0] as string },
    })
    expect(served.status).toBe(200)
    expect(await served.text()).toBe('team app')
  })

  it('answers a refused browser with the 404 page at the URL it asked for, after a deny handoff', async () => {
    const t = signDenyHandoff({ s: 'S3', x: Math.floor(Date.now() / 1000) + 60 }, cf.siteKey)
    const deny = await req('team.sites.example.test', `/_fling-pass?t=${t}&r=%2Fdocs%2F`)
    expect(deny.status).toBe(302)
    expect(deny.headers.get('location')).toBe('/docs/')
    const setCookie = deny.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(
      /^fling_pass=[^;]+; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=10$/
    )
    const refused = await req('team.sites.example.test', '/docs/', {
      headers: { cookie: setCookie.split(';')[0] as string },
    })
    expect(refused.status).toBe(404)
    expect(refused.headers.get('cache-control')).toBe('no-store')
    const unknown = await req('nobody.sites.example.test', '/docs/')
    expect(await refused.text()).toBe(await unknown.text())
  })

  it('says no-referrer on every response on a share host, and leaves site hosts the default', async () => {
    const file = await req(SHARE)
    expect(file.status).toBe(200)
    const etag = file.headers.get('etag') as string
    const responses = [
      file,
      await req(SHARE, '/', { headers: { 'if-none-match': etag } }), // 304
      await req(SHARE, '/', { method: 'HEAD' }),
      await req(SHARE, '/missing.html'), // the 404 page
      await req(SHARE, '/_fling/404.html'),
      await req(SHARE, '/_fling/review.html?path=%2F'),
      await req(SHARE, '/docs'), // 301 to add the slash
      await req(SHARE, '/', { method: 'POST' }), // 405
      await req(`s--${'z'.repeat(20)}.sites.example.test`), // a revoked or unknown link
    ]
    expect(responses.map(r => r.status)).toEqual([200, 304, 200, 404, 200, 200, 301, 405, 404])
    for (const res of responses) {
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('x-robots-tag')).toBe('noindex')
    }
    for (const res of [
      await req('pub.sites.example.test'),
      await req('pub.sites.example.test', '/missing.html'),
      await req('pub.sites.example.test', '/_fling/review.html?path=%2F'),
      await req('priv.sites.example.test', '/x'),
      await req('nope.sites.example.test'),
    ]) {
      expect(res.headers.get('referrer-policy')).toBeNull()
      expect(res.headers.get('x-robots-tag')).toBe('noindex')
    }
  })

  it("answers /robots.txt on every sites host with Fling's Disallow, over the site's own", async () => {
    await cf.bucket.put('sites/S1/V1/robots.txt', 'User-agent: *\nAllow: /\n')
    for (const host of ['pub.sites.example.test', SHARE, 'nope.sites.example.test']) {
      const res = await req(host, '/robots.txt')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(await res.text()).toBe('User-agent: *\nDisallow: /\n')
    }
  })

  it('refuses other methods', async () => {
    const res = await req('pub.sites.example.test', '/', { method: 'POST' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, HEAD')
  })
})
