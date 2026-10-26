import { parseLabel } from '@fling/shared/hosts'
import { SITE_HMAC_KVS_KEY, shareKvsKey, siteKvsKey } from '@fling/shared/kvs'
import { signSiteCookie } from '@fling/shared/site-cookie'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type CloudFrontRequest,
  type CloudFrontResponse,
  createSiteRouter,
  isResponse,
  renderSiteRouter,
  SITE_ROUTER_SOURCE,
  type SiteRouter,
  toCloudFrontEvent,
} from '../index.mjs'

const APP = 'https://fling.example.test'
const HMAC = 'test-hmac-key'
const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000
const TOKEN = 'abcdefghij0123456789'
const PRIVATE = 'my-app.fling.example.test'
const PUBLIC = 'pub.fling.example.test'
const SPA = 'spa.fling.example.test'
const SHARE = `s--${TOKEN}.fling.example.test`

const store = new Map<string, string>([
  [SITE_HMAC_KVS_KEY, HMAC],
  [siteKvsKey('my-app'), JSON.stringify({ id: 'S1', v: 'V1', vis: 'private', spa: false })],
  [siteKvsKey('pub'), JSON.stringify({ id: 'S2', v: 'V2', vis: 'public', spa: false })],
  [siteKvsKey('spa'), JSON.stringify({ id: 'S3', v: 'V3', vis: 'public', spa: true })],
  [siteKvsKey('www'), JSON.stringify({ id: 'S9', v: 'V9', vis: 'public', spa: false })],
  [siteKvsKey('s'), JSON.stringify({ id: 'S9', v: 'V9', vis: 'public', spa: false })],
  [shareKvsKey(TOKEN), JSON.stringify({ id: 'S1', v: 'V1', vis: 'private', spa: false })],
])

let router: SiteRouter
beforeEach(() => {
  router = createSiteRouter({
    kvs: { get: async key => store.get(key) },
    appOrigin: APP,
    now: () => NOW_MS,
  })
})

const validCookie = () =>
  `fling_site=${signSiteCookie({ e: 'alice@example.test', x: NOW_S + 60 }, HMAC)}`

async function asRequest(
  ...args: Parameters<typeof toCloudFrontEvent>
): Promise<CloudFrontRequest> {
  const result = await router(toCloudFrontEvent(...args))
  if (isResponse(result)) throw new Error(`expected request, got ${result.statusCode}`)
  return result
}

async function asResponse(
  ...args: Parameters<typeof toCloudFrontEvent>
): Promise<CloudFrontResponse> {
  const result = await router(toCloudFrontEvent(...args))
  if (!isResponse(result)) throw new Error(`expected response, got uri ${result.uri}`)
  return result
}

describe('auth for private sites', () => {
  it('302s to app login with the encoded return URL when there is no cookie', async () => {
    const res = await asResponse({ host: PRIVATE, path: '/docs/a.html', query: 'x=1&y=a%20b' })
    expect(res.statusCode).toBe(302)
    expect(res.headers?.['cache-control']?.value).toBe('no-store')
    expect(res.headers?.location?.value).toBe(
      `${APP}/auth/login?return=${encodeURIComponent(`https://${PRIVATE}/docs/a.html?x=1&y=a%20b`)}`
    )
  })

  it('uses the configured site scheme and keeps the port in the return URL', async () => {
    const dev = createSiteRouter({
      kvs: { get: async key => store.get(key) },
      appOrigin: 'http://localhost:47101',
      siteScheme: 'http',
      now: () => NOW_MS,
    })
    const res = (await dev(
      toCloudFrontEvent({ host: 'my-app.localhost:47101', path: '/' })
    )) as CloudFrontResponse
    expect(res.headers?.location?.value).toBe(
      `http://localhost:47101/auth/login?return=${encodeURIComponent('http://my-app.localhost:47101/')}`
    )
  })

  it('rewrites with a valid cookie', async () => {
    const req = await asRequest({ host: PRIVATE, path: '/', cookieHeader: `a=b; ${validCookie()}` })
    expect(req.uri).toBe('/sites/S1/V1/index.html')
  })

  it('rejects expired cookies', async () => {
    const c = signSiteCookie({ e: 'alice@example.test', x: NOW_S }, HMAC)
    const res = await asResponse({ host: PRIVATE, cookieHeader: `fling_site=${c}` })
    expect(res.statusCode).toBe(302)
  })

  it('rejects tampered and wrong-key cookies', async () => {
    const good = signSiteCookie({ e: 'alice@example.test', x: NOW_S + 60 }, HMAC)
    const [, mac] = good.split('.')
    const forged = `${Buffer.from(JSON.stringify({ e: 'eve@x.com', x: NOW_S + 9999 })).toString('base64url')}.${mac}`
    const wrongKey = signSiteCookie({ e: 'alice@example.test', x: NOW_S + 60 }, 'other')
    for (const c of [forged, wrongKey, `${good}.extra`, 'garbage', '']) {
      const res = await asResponse({ host: PRIVATE, cookieHeader: `fling_site=${c}` })
      expect(res.statusCode).toBe(302)
    }
  })

  it('302s when the HMAC key is missing from the KVS', async () => {
    const r = createSiteRouter({
      kvs: { get: async key => (key === SITE_HMAC_KVS_KEY ? undefined : store.get(key)) },
      appOrigin: APP,
      now: () => NOW_MS,
    })
    const res = (await r(
      toCloudFrontEvent({ host: PRIVATE, cookieHeader: validCookie() })
    )) as CloudFrontResponse
    expect(res.statusCode).toBe(302)
  })

  it('serves public sites without a cookie', async () => {
    expect((await asRequest({ host: PUBLIC, path: '/a.css' })).uri).toBe('/sites/S2/V2/a.css')
  })

  it('serves share hosts without auth even when the site is private', async () => {
    expect((await asRequest({ host: SHARE, path: '/' })).uri).toBe('/sites/S1/V1/index.html')
  })
})

describe('unknown hosts', () => {
  it.each([
    ['unknown label', 'nope.fling.example.test'],
    ['bare domain', 'fling.example.test'],
    ['old name--user label', 'my-app--alice.fling.example.test'],
    ['malformed label', 'a--b--c.fling.example.test'],
    ['bad share token', 's--short.fling.example.test'],
    ['old single-dash share', `s-${TOKEN}.fling.example.test`],
    ['unknown share', 's--zzzzzzzzzzzzzzzzzzzz.fling.example.test'],
    ['invalid characters', '_x_.fling.example.test'],
    ['reserved name (even if in KVS)', 'www.fling.example.test'],
    ['name over 50 chars', `${'a'.repeat(51)}.fling.example.test`],
    ['trailing hyphen', 'my-app-.fling.example.test'],
  ])('%s → /_fling/missing', async (_, host) => {
    expect((await asRequest({ host, path: '/index.html' })).uri).toBe('/_fling/missing')
  })

  it('archived site (removed from KVS) → /_fling/missing', async () => {
    const r = createSiteRouter({ kvs: { get: async () => undefined }, appOrigin: APP })
    const req = (await r(toCloudFrontEvent({ host: PUBLIC, path: '/' }))) as CloudFrontRequest
    expect(req.uri).toBe('/_fling/missing')
  })

  it('passes /_fling/404.html through unchanged', async () => {
    expect((await asRequest({ host: 'x.fling.example.test', path: '/_fling/404.html' })).uri).toBe(
      '/_fling/404.html'
    )
    expect((await asRequest({ host: PRIVATE, path: '/_fling/404.html' })).uri).toBe(
      '/_fling/404.html'
    )
  })

  it('passes the review shell through unchanged, on any host and without a cookie', async () => {
    for (const host of ['x.fling.example.test', PRIVATE, PUBLIC]) {
      expect((await asRequest({ host, path: '/_fling/review.html' })).uri).toBe(
        '/_fling/review.html'
      )
    }
  })

  it('refuses dot segments', async () => {
    for (const path of ['/../S9/V9/a.html', '/a/./b.html', '/%2e%2E/x.html']) {
      expect((await asRequest({ host: PUBLIC, path })).uri).toBe('/_fling/missing')
    }
  })

  it('never serves dotfiles or dot directories', async () => {
    for (const path of [
      '/.env',
      '/.dev.vars',
      '/.git/config',
      '/a/.secret',
      '/%2Eenv',
      '/.well-known/x',
    ]) {
      expect((await asRequest({ host: PUBLIC, path })).uri).toBe('/_fling/missing')
    }
    // dots elsewhere in a name are fine
    expect((await asRequest({ host: PUBLIC, path: '/a.b/c.d.html' })).uri).toBe(
      '/sites/S2/V2/a.b/c.d.html'
    )
  })
})

describe('path rewriting', () => {
  it('maps / and trailing slashes to index.html', async () => {
    expect((await asRequest({ host: PUBLIC, path: '/' })).uri).toBe('/sites/S2/V2/index.html')
    expect((await asRequest({ host: PUBLIC, path: '/docs/' })).uri).toBe(
      '/sites/S2/V2/docs/index.html'
    )
  })

  it('keeps percent-encoding as given', async () => {
    expect((await asRequest({ host: PUBLIC, path: '/a%20b.png' })).uri).toBe(
      '/sites/S2/V2/a%20b.png'
    )
  })

  it('301s extensionless paths to a trailing slash, preserving the query', async () => {
    const res = await asResponse({ host: PUBLIC, path: '/docs', query: 'a=1&a=2&b' })
    expect(res.statusCode).toBe(301)
    expect(res.headers?.location?.value).toBe('/docs/?a=1&a=2&b=')
  })

  it('spa: extensionless paths fall back to /index.html; files pass through', async () => {
    expect((await asRequest({ host: SPA, path: '/users/42' })).uri).toBe('/sites/S3/V3/index.html')
    expect((await asRequest({ host: SPA, path: '/assets/x.js' })).uri).toBe(
      '/sites/S3/V3/assets/x.js'
    )
    expect((await asRequest({ host: SPA, path: '/missing.png' })).uri).toBe(
      '/sites/S3/V3/missing.png'
    )
  })

  it('leaves the querystring on the forwarded request', async () => {
    const req = await asRequest({ host: PUBLIC, path: '/a.html', query: 'q=1' })
    expect(req.querystring).toEqual({ q: { value: '1' } })
  })

  it('accepts HEAD and rejects other methods with 405', async () => {
    expect((await asRequest({ method: 'HEAD', host: PUBLIC, path: '/' })).uri).toBe(
      '/sites/S2/V2/index.html'
    )
    const res = await asResponse({ method: 'POST', host: PUBLIC, path: '/' })
    expect(res.statusCode).toBe(405)
    expect(res.headers?.allow?.value).toBe('GET, HEAD')
  })
})

describe('label parsing parity with shared/hosts.ts', () => {
  it.each([
    'my-app',
    's',
    'a'.repeat(50),
    'a'.repeat(51),
    'www',
    'my--app',
    `s--${TOKEN}`,
    `s--${TOKEN}x`,
    `x--${TOKEN}`,
    '-a',
    'My-App',
  ])('%s', async label => {
    const parsed = parseLabel(label.toLowerCase()) // hosts are case-insensitive
    const r = createSiteRouter({
      kvs: {
        get: async key =>
          key.startsWith('site:') || key.startsWith('share:')
            ? JSON.stringify({ id: key, v: 'V', vis: 'public', spa: false })
            : undefined,
      },
      appOrigin: APP,
    })
    const req = (await r(
      toCloudFrontEvent({ host: `${label}.fling.example.test`, path: '/a.html' })
    )) as CloudFrontRequest
    const expected = !parsed
      ? '/_fling/missing'
      : parsed.kind === 'site'
        ? `/sites/${siteKvsKey(parsed.name)}/V/a.html`
        : `/sites/${shareKvsKey(parsed.token)}/V/a.html`
    expect(req.uri).toBe(expected)
  })
})

describe('deployable source', () => {
  it('is under the 10 KB CloudFront Functions limit', () => {
    expect(Buffer.byteLength(renderSiteRouter({ appOrigin: APP }))).toBeLessThan(10 * 1024)
  })

  it('only imports cloudfront and crypto, exports nothing and has both placeholders', () => {
    const imports = SITE_ROUTER_SOURCE.match(/^import .*$/gm)
    expect(imports).toEqual(['import cf from "cloudfront";', 'import crypto from "crypto";'])
    expect(SITE_ROUTER_SOURCE).not.toMatch(/^export\b/m)
    expect(SITE_ROUTER_SOURCE).toMatch(/^async function handler\(event\)/m)
    expect(SITE_ROUTER_SOURCE).not.toMatch(/\brequire\(/)
    const rendered = renderSiteRouter({ appOrigin: APP })
    expect(rendered).toContain(`"${APP}"`)
    expect(rendered).not.toMatch(/__APP_ORIGIN__|__SITE_SCHEME__/)
  })
})
