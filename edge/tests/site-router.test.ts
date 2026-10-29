import { parseLabel } from '@fling/shared/hosts'
import { revokedKvsKey, SITE_HMAC_KVS_KEY, shareKvsKey, siteKvsKey } from '@fling/shared/kvs'
import {
  revocationMac,
  SITE_COOKIE_TTL_SECONDS,
  signDenyHandoff,
  signPassHandoff,
  signSiteCookie,
  signSiteDenied,
  signSitePass,
  verifySiteDenial,
  verifySitePass,
} from '@fling/shared/site-cookie'
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
const RESTRICTED = 'team.fling.example.test'
const RESTRICTED_SHARE = `s--${'r'.repeat(20)}.fling.example.test`

const store = new Map<string, string>([
  [SITE_HMAC_KVS_KEY, HMAC],
  [siteKvsKey('my-app'), JSON.stringify({ id: 'S1', v: 'V1', vis: 'private', spa: false })],
  [siteKvsKey('pub'), JSON.stringify({ id: 'S2', v: 'V2', vis: 'public', spa: false })],
  [siteKvsKey('spa'), JSON.stringify({ id: 'S3', v: 'V3', vis: 'public', spa: true })],
  [siteKvsKey('www'), JSON.stringify({ id: 'S9', v: 'V9', vis: 'public', spa: false })],
  [siteKvsKey('s'), JSON.stringify({ id: 'S9', v: 'V9', vis: 'public', spa: false })],
  [shareKvsKey(TOKEN), JSON.stringify({ id: 'S1', v: 'V1', vis: 'private', spa: false })],
  [siteKvsKey('team'), JSON.stringify({ id: 'S7', v: 'V7', vis: 'private', spa: false, r: 1 })],
  [
    shareKvsKey('r'.repeat(20)),
    JSON.stringify({ id: 'S7', v: 'V7', vis: 'private', spa: false, r: 1 }),
  ],
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

  it("sends a guest's cookie through the sign-in hop for a site pass", async () => {
    const c = signSiteCookie({ e: 'guest@outside.test', x: NOW_S + 60, g: 1 }, HMAC)
    const res = await asResponse({ host: PRIVATE, path: '/', cookieHeader: `fling_site=${c}` })
    expect(res.statusCode).toBe(302)
    expect(res.headers?.location?.value).toBe(
      `${APP}/auth/login?return=${encodeURIComponent(`https://${PRIVATE}/`)}`
    )
  })

  it("sends a member's cookie issued before their revocation to sign in, and serves a newer one", async () => {
    const email = 'gone@outside.test'
    const at = NOW_S - 60
    const kvs = new Map(store)
    kvs.set(revokedKvsKey(revocationMac(email, HMAC)), String(at + SITE_COOKIE_TTL_SECONDS))
    const r = createSiteRouter({
      kvs: { get: async key => kvs.get(key) },
      appOrigin: APP,
      now: () => NOW_MS,
    })
    const issued = (t: number) =>
      `fling_site=${signSiteCookie({ e: email, x: t + SITE_COOKIE_TTL_SECONDS }, HMAC)}`
    const old = await r(toCloudFrontEvent({ host: PRIVATE, cookieHeader: issued(at - 1) }))
    expect(isResponse(old) && old.statusCode).toBe(302)
    const fresh = await r(toCloudFrontEvent({ host: PRIVATE, cookieHeader: issued(at + 1) }))
    expect(isResponse(fresh) ? fresh.statusCode : fresh.uri).toBe('/sites/S1/V1/index.html')
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

describe('restricted sites and the site pass', () => {
  const pass = (s = 'S7', x = NOW_S + 60, key = HMAC) =>
    `fling_pass=${signSitePass({ s, e: 'bob@example.test', x }, key)}`
  const handoff = (s = 'S7', x = NOW_S + 60) =>
    signPassHandoff({ s, e: 'bob@example.test', x }, HMAC)
  const deny = (s = 'S7', x = NOW_S + 60) => signDenyHandoff({ s, x }, HMAC)
  const denied = (s = 'S7', x = NOW_S + 60, key = HMAC) =>
    `fling_pass=${signSiteDenied({ s, x }, key)}`
  const login = (back: string) => `${APP}/auth/login?return=${encodeURIComponent(back)}`

  it('serves with a valid pass for this site', async () => {
    const req = await asRequest({ host: RESTRICTED, path: '/', cookieHeader: `a=b; ${pass()}` })
    expect(req.uri).toBe('/sites/S7/V7/index.html')
  })

  it('sends everyone else to sign in: no pass, a member cookie, or a pass for another site', async () => {
    for (const cookieHeader of [
      undefined,
      validCookie(),
      pass('S1'),
      pass('S7', NOW_S),
      pass('S7', NOW_S + 60, 'other'),
      `fling_pass=${handoff()}`,
      `fling_pass=${deny()}`,
      denied('S1'),
      denied('S7', NOW_S),
      denied('S7', NOW_S + 60, 'other'),
      'fling_pass=garbage',
    ]) {
      const res = await asResponse({
        host: RESTRICTED,
        path: '/a.html',
        query: 'q=1',
        cookieHeader,
      })
      expect({
        cookieHeader,
        status: res.statusCode,
        location: res.headers?.location?.value,
      }).toEqual({
        cookieHeader,
        status: 302,
        location: login(`https://${RESTRICTED}/a.html?q=1`),
      })
    }
  })

  it('never takes a pass, a handoff or a refusal as a member cookie', async () => {
    for (const token of [
      signSitePass({ s: 'S1', e: 'b@x.test', x: NOW_S + 60 }, HMAC),
      handoff('S1'),
      deny('S1'),
      signSiteDenied({ s: 'S1', x: NOW_S + 60 }, HMAC),
    ]) {
      const res = await asResponse({ host: PRIVATE, cookieHeader: `fling_site=${token}` })
      expect(res.statusCode).toBe(302)
    }
  })

  it('serves share hosts without a pass', async () => {
    expect((await asRequest({ host: RESTRICTED_SHARE, path: '/' })).uri).toBe(
      '/sites/S7/V7/index.html'
    )
  })

  it('turns a valid handoff into a host-only pass and goes on to the path', async () => {
    const r = encodeURIComponent('/docs/a.html?x=1&y=2')
    const res = await asResponse({
      host: RESTRICTED,
      path: '/_fling-pass',
      query: `t=${handoff()}&r=${r}`,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers?.location?.value).toBe('/docs/a.html?x=1&y=2')
    expect(res.headers?.['cache-control']?.value).toBe('no-store')
    const cookie = res.cookies?.fling_pass
    expect(cookie?.attributes).toBe('Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=300')
    expect(cookie?.attributes).not.toMatch(/Domain/i)
    expect(verifySitePass(cookie?.value ?? '', HMAC, 'pass', NOW_S)).toEqual({
      s: 'S7',
      e: 'bob@example.test',
      x: NOW_S + 300,
    })
    // …which then opens the site.
    const req = await asRequest({ host: RESTRICTED, cookieHeader: `fling_pass=${cookie?.value}` })
    expect(req.uri).toBe('/sites/S7/V7/index.html')
  })

  it('turns a deny handoff into a refusal: the 404 page at the same URL until it runs out', async () => {
    const res = await asResponse({
      host: RESTRICTED,
      path: '/_fling-pass',
      query: `t=${deny()}&r=${encodeURIComponent('/docs/a.html?x=1')}`,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers?.location?.value).toBe('/docs/a.html?x=1')
    const cookie = res.cookies?.fling_pass
    expect(cookie?.attributes).toBe('Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=10')
    expect(verifySiteDenial(cookie?.value ?? '', HMAC, 'denied', NOW_S)).toEqual({
      s: 'S7',
      x: NOW_S + 10,
    })
    expect(verifySitePass(cookie?.value ?? '', HMAC, 'pass', NOW_S)).toBeNull()
    const refused = `fling_pass=${cookie?.value}`
    expect(
      (await asRequest({ host: RESTRICTED, path: '/docs/a.html', cookieHeader: refused })).uri
    ).toBe('/_fling/missing')
    // …and once it runs out, the next visit asks the app again.
    const later = createSiteRouter({
      kvs: { get: async key => store.get(key) },
      appOrigin: APP,
      now: () => NOW_MS + 10_000,
    })
    const again = (await later(
      toCloudFrontEvent({ host: RESTRICTED, path: '/', cookieHeader: refused })
    )) as CloudFrontResponse
    expect(again.statusCode).toBe(302)
    expect(again.headers?.location?.value).toBe(login(`https://${RESTRICTED}/`))
  })

  it('a pass handoff replaces a refusal', async () => {
    const res = await asResponse({
      host: RESTRICTED,
      path: '/_fling-pass',
      query: `t=${handoff()}&r=%2F`,
      cookieHeader: denied(),
    })
    const cookie = res.cookies?.fling_pass?.value
    const req = await asRequest({ host: RESTRICTED, cookieHeader: `fling_pass=${cookie}` })
    expect(req.uri).toBe('/sites/S7/V7/index.html')
  })

  it('leaves Secure off over plain http', async () => {
    const dev = createSiteRouter({
      kvs: { get: async key => store.get(key) },
      appOrigin: 'http://localhost:47101',
      siteScheme: 'http',
      now: () => NOW_MS,
    })
    const res = (await dev(
      toCloudFrontEvent({ host: RESTRICTED, path: '/_fling-pass', query: `t=${handoff()}&r=%2F` })
    )) as CloudFrontResponse
    expect(res.cookies?.fling_pass?.attributes).toBe('HttpOnly; SameSite=Lax; Path=/; Max-Age=300')
  })

  it('sets no cookie for an expired, foreign or forged handoff, or a pass in its place', async () => {
    const forged = `${handoff().split('.')[0]}.${'A'.repeat(43)}`
    const deniedToken = denied().slice(11)
    for (const t of [
      handoff('S7', NOW_S),
      handoff('S1'),
      forged,
      pass().slice(11),
      deniedToken,
      deny('S7', NOW_S),
      deny('S1'),
      '',
    ]) {
      const res = await asResponse({
        host: RESTRICTED,
        path: '/_fling-pass',
        query: `t=${t}&r=%2Fx`,
      })
      expect({ t, status: res.statusCode, location: res.headers?.location?.value }).toEqual({
        t,
        status: 302,
        location: '/x',
      })
      expect(res.cookies).toBeUndefined()
    }
  })

  it('only goes on to a path on the same host', async () => {
    for (const [r, location] of [
      ['%2Fok', '/ok'],
      ['https%3A%2F%2Fevil.test%2F', '/'],
      ['%2F%2Fevil.test', '/'],
      ['%2F%5Cevil.test', '/'],
      ['%2Fa%0D%0ASet-Cookie%3A%20x', '/'],
      ['%E0%A4%A', '/'],
      ['', '/'],
    ]) {
      const res = await asResponse({
        host: RESTRICTED,
        path: '/_fling-pass',
        query: `t=${handoff()}&r=${r}`,
      })
      expect({ r, location: res.headers?.location?.value }).toEqual({ r, location })
    }
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

describe('indexing and the referrer policy', () => {
  it("rewrites /robots.txt to Fling's on every host, the site's own included", async () => {
    for (const host of [PUBLIC, PRIVATE, SHARE, 'nope.fling.example.test']) {
      expect((await asRequest({ host, path: '/robots.txt' })).uri).toBe('/_fling/robots.txt')
    }
  })

  it('answers on a share host with no-referrer and noindex: 301 and 405', async () => {
    for (const res of [
      await asResponse({ host: SHARE, path: '/docs' }),
      await asResponse({ host: SHARE, method: 'POST' }),
    ]) {
      expect(res.headers?.['referrer-policy']?.value).toBe('no-referrer')
      expect(res.headers?.['x-robots-tag']?.value).toBe('noindex')
    }
  })

  it('answers on a site-name host with noindex and the default referrer policy', async () => {
    for (const res of [
      await asResponse({ host: PUBLIC, path: '/docs' }),
      await asResponse({ host: PUBLIC, method: 'POST' }),
      await asResponse({ host: PRIVATE, path: '/' }),
      await asResponse({ host: RESTRICTED, path: '/' }),
    ]) {
      expect(res.headers?.['referrer-policy']).toBeUndefined()
      expect(res.headers?.['x-robots-tag']?.value).toBe('noindex')
    }
  })

  it('forwards a rewritten request without adding headers to it', async () => {
    const req = await asRequest({ host: SHARE, path: '/a.html' })
    expect(Object.keys(req.headers)).toEqual(['host'])
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
