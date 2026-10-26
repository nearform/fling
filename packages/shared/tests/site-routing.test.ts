// The routing decision itself, without a runtime shell. Every shell (edge/ for CloudFront, the
// Cloudflare Worker) gets the full behaviour suite against its own wiring; these pin the
// function's contract: lookups made, decisions returned.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MISSING_KEY, NOT_FOUND_PAGE, REVIEW_SHELL, SITE_HMAC_KVS_KEY } from '../src/route-keys.ts'
import { signSiteCookie } from '../src/site-cookie.ts'
import {
  normalizeQuery,
  routeKeyForHost,
  routeSiteRequest,
  type SiteRequest,
} from '../src/site-routing.ts'

const KEY = 'k'.repeat(40)
const NOW = 1_800_000_000
const routes = new Map([
  ['site:pub', JSON.stringify({ id: 'S1', v: 'V1', vis: 'public', spa: false })],
  ['site:priv', JSON.stringify({ id: 'S2', v: 'V2', vis: 'private', spa: true })],
])

function ctx(lookups: string[] = []) {
  return {
    appOrigin: 'https://app.example.test',
    siteScheme: 'https',
    nowSeconds: NOW,
    getRoute: async (key: string) => {
      lookups.push(key)
      return routes.get(key) ?? null
    },
    getCookieKey: async () => {
      lookups.push(SITE_HMAC_KVS_KEY)
      return KEY
    },
    hmac: (key: string, data: string) => createHmac('sha256', key).update(data).digest('base64url'),
  }
}

const req = (over: Partial<SiteRequest>): SiteRequest => ({
  method: 'GET',
  host: 'pub.sites.example.test',
  uri: '/',
  query: '',
  cookie: null,
  ...over,
})

describe('routeSiteRequest', () => {
  it('serves the 404 page and the review shell on any host without a lookup', async () => {
    for (const uri of [NOT_FOUND_PAGE, REVIEW_SHELL]) {
      for (const host of ['priv.sites.example.test', 'nope.sites.example.test', '']) {
        const lookups: string[] = []
        expect(await routeSiteRequest(req({ host, uri }), ctx(lookups))).toEqual({
          action: 'rewrite',
          uri,
        })
        expect(lookups).toEqual([])
      }
    }
  })

  it('rewrites a public site to its object key', async () => {
    expect(await routeSiteRequest(req({ uri: '/a/' }), ctx())).toEqual({
      action: 'rewrite',
      uri: '/sites/S1/V1/a/index.html',
    })
  })

  it('sends a private site without a cookie to sign in, without reading the cookie key', async () => {
    const lookups: string[] = []
    const d = await routeSiteRequest(
      req({ host: 'priv.sites.example.test', uri: '/x', query: '?q=1' }),
      ctx(lookups)
    )
    expect(d).toEqual({
      action: 'respond',
      status: 302,
      statusDescription: 'Found',
      headers: {
        location: `https://app.example.test/auth/login?return=${encodeURIComponent('https://priv.sites.example.test/x?q=1')}`,
        'cache-control': 'no-store',
      },
    })
    expect(lookups).toEqual(['site:priv'])
  })

  it('serves a private SPA with a valid cookie', async () => {
    const cookie = signSiteCookie({ e: 'a@example.test', x: NOW + 1 }, KEY)
    expect(
      await routeSiteRequest(req({ host: 'priv.sites.example.test', uri: '/u/1', cookie }), ctx())
    ).toEqual({ action: 'rewrite', uri: '/sites/S2/V2/index.html' })
  })

  it('rewrites unknown hosts to the missing key without a lookup for malformed labels', async () => {
    const lookups: string[] = []
    expect(await routeSiteRequest(req({ host: 'a--b.sites.example.test' }), ctx(lookups))).toEqual({
      action: 'rewrite',
      uri: MISSING_KEY,
    })
    expect(lookups).toEqual([])
  })

  it('answers 405 to anything but GET and HEAD', async () => {
    const d = await routeSiteRequest(req({ method: 'PUT' }), ctx())
    expect(d).toMatchObject({ action: 'respond', status: 405, headers: { allow: 'GET, HEAD' } })
  })
})

describe('routeKeyForHost', () => {
  it('maps the first label, ignoring case and port', () => {
    expect(routeKeyForHost('My-App.sites.example.test:8787')).toEqual({
      key: 'site:my-app',
      share: false,
    })
    expect(routeKeyForHost(`s--${'a'.repeat(20)}.x`)).toEqual({
      key: `share:${'a'.repeat(20)}`,
      share: true,
    })
    expect(routeKeyForHost('www.x')).toBeNull()
  })
})

describe('normalizeQuery', () => {
  it('repeats the query as the CloudFront Function does', () => {
    expect(normalizeQuery('')).toBe('')
    expect(normalizeQuery('?')).toBe('')
    expect(normalizeQuery('a=1&b&c=%20')).toBe('?a=1&b=&c=%20')
  })
})
