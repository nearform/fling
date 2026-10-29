// The routing decision itself, without a runtime shell. Every shell (edge/ for CloudFront, the
// Cloudflare Worker) gets the full behaviour suite against its own wiring; these pin the
// function's contract: lookups made, decisions returned.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  MISSING_KEY,
  NOT_FOUND_PAGE,
  REVIEW_SHELL,
  ROBOTS_TXT,
  SITE_HMAC_KVS_KEY,
} from '../src/route-keys.ts'
import {
  signDenyHandoff,
  signPassHandoff,
  signSiteCookie,
  signSiteDenied,
  signSitePass,
  verifySiteCookie,
  verifySiteDenial,
  verifySitePass,
} from '../src/site-cookie.ts'
import {
  normalizeQuery,
  routeKeyForHost,
  routeSiteRequest,
  type SiteRequest,
  siteCookieOf,
  siteResponseHeaders,
  validSiteCookie,
  validSiteDenial,
  validSitePass,
} from '../src/site-routing.ts'

const KEY = 'k'.repeat(40)
const NOW = 1_800_000_000
const routes = new Map([
  ['site:pub', JSON.stringify({ id: 'S1', v: 'V1', vis: 'public', spa: false })],
  ['site:priv', JSON.stringify({ id: 'S2', v: 'V2', vis: 'private', spa: true })],
  [`share:${'t'.repeat(20)}`, JSON.stringify({ id: 'S2', v: 'V2', vis: 'private', spa: false })],
])
const SHARE = `s--${'t'.repeat(20)}.sites.example.test`
const NOINDEX = { 'x-robots-tag': 'noindex' }

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
  pass: null,
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
          headers: NOINDEX,
        })
        expect(lookups).toEqual([])
      }
    }
  })

  it('rewrites a public site to its object key', async () => {
    expect(await routeSiteRequest(req({ uri: '/a/' }), ctx())).toEqual({
      action: 'rewrite',
      uri: '/sites/S1/V1/a/index.html',
      headers: NOINDEX,
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
        ...NOINDEX,
      },
    })
    expect(lookups).toEqual(['site:priv'])
  })

  it('serves a private SPA with a valid cookie', async () => {
    const cookie = signSiteCookie({ e: 'a@example.test', x: NOW + 1 }, KEY)
    expect(
      await routeSiteRequest(req({ host: 'priv.sites.example.test', uri: '/u/1', cookie }), ctx())
    ).toEqual({ action: 'rewrite', uri: '/sites/S2/V2/index.html', headers: NOINDEX })
  })

  it("sends a guest's cookie on a members-level site through the site pass, and serves them public ones", async () => {
    const cookie = signSiteCookie({ e: 'g@outside.test', x: NOW + 1, g: 1 }, KEY)
    const host = 'priv.sites.example.test'
    // No pass: to sign in, where the app refreshes the cookie and asks policy.
    expect(await routeSiteRequest(req({ host, uri: '/u/1', cookie }), ctx())).toEqual({
      action: 'respond',
      status: 302,
      statusDescription: 'Found',
      headers: {
        location: `https://app.example.test/auth/login?return=${encodeURIComponent(`https://${host}/u/1`)}`,
        'cache-control': 'no-store',
        ...NOINDEX,
      },
    })
    // The app's refusal: the site answers as a missing one while it lasts.
    const denied = signSiteDenied({ s: 'S2', x: NOW + 1 }, KEY)
    expect(await routeSiteRequest(req({ host, uri: '/u/1', cookie, pass: denied }), ctx())).toEqual(
      { action: 'rewrite', uri: MISSING_KEY, headers: NOINDEX }
    )
    // The handoff path takes the deny handoff, as on a restricted site.
    const handoff = signDenyHandoff({ s: 'S2', x: NOW + 1 }, KEY)
    const taken = await routeSiteRequest(
      req({ host, uri: '/_fling-pass', query: `?t=${handoff}&r=%2Fu%2F1`, cookie }),
      ctx()
    )
    expect(taken.action === 'respond' && taken.cookies?.fling_pass).toBeTruthy()
    // A member's cookie needs no pass.
    const member = signSiteCookie({ e: 'a@example.test', x: NOW + 1 }, KEY)
    expect((await routeSiteRequest(req({ host, uri: '/', cookie: member }), ctx())).action).toBe(
      'rewrite'
    )
    expect(
      await routeSiteRequest(req({ host: 'pub.sites.example.test', uri: '/', cookie }), ctx())
    ).toEqual({ action: 'rewrite', uri: '/sites/S1/V1/index.html', headers: NOINDEX })
    expect(validSiteCookie(cookie, KEY, NOW, ctx().hmac)).toBe(true)
    expect(siteCookieOf(cookie, KEY, NOW, ctx().hmac)).toBe('guest')
  })

  it('rewrites unknown hosts to the missing key without a lookup for malformed labels', async () => {
    const lookups: string[] = []
    expect(await routeSiteRequest(req({ host: 'a--b.sites.example.test' }), ctx(lookups))).toEqual({
      action: 'rewrite',
      uri: MISSING_KEY,
      headers: NOINDEX,
    })
    expect(lookups).toEqual([])
  })

  it('answers 405 to anything but GET and HEAD', async () => {
    const d = await routeSiteRequest(req({ method: 'PUT' }), ctx())
    expect(d).toMatchObject({ action: 'respond', status: 405, headers: { allow: 'GET, HEAD' } })
  })
})

describe('indexing', () => {
  it("answers /robots.txt with Fling's on every host, before any lookup", async () => {
    for (const host of ['pub.sites.example.test', SHARE, 'nope.sites.example.test', '']) {
      const lookups: string[] = []
      const d = await routeSiteRequest(req({ host, uri: '/robots.txt' }), ctx(lookups))
      expect(d).toMatchObject({ action: 'rewrite', uri: ROBOTS_TXT, headers: NOINDEX })
      expect(lookups).toEqual([])
    }
    const head = await routeSiteRequest(req({ method: 'HEAD', uri: '/robots.txt' }), ctx())
    expect(head).toMatchObject({ action: 'rewrite', uri: ROBOTS_TXT })
    // only the root's: elsewhere it is the site's own file
    expect(await routeSiteRequest(req({ uri: '/a/robots.txt' }), ctx())).toMatchObject({
      uri: '/sites/S1/V1/a/robots.txt',
    })
  })

  it('says noindex on every decision, on every host', async () => {
    for (const r of [
      req({}),
      req({ uri: '/docs' }),
      req({ method: 'POST' }),
      req({ host: 'priv.sites.example.test' }),
      req({ host: SHARE }),
      req({ host: 'a--b.sites.example.test' }),
      req({ uri: NOT_FOUND_PAGE }),
    ]) {
      expect((await routeSiteRequest(r, ctx())).headers).toMatchObject(NOINDEX)
    }
  })
})

describe('the referrer policy', () => {
  const NO_REFERRER = { 'referrer-policy': 'no-referrer' }

  it('says no-referrer on every decision for a share host: rewrites and answers alike', async () => {
    const decisions = await Promise.all(
      [
        req({ host: SHARE, uri: '/a.html' }),
        req({ host: SHARE.toUpperCase(), uri: '/' }),
        req({ host: `${SHARE}:8443`, uri: '/missing/' }),
        req({ host: SHARE, uri: NOT_FOUND_PAGE }),
        req({ host: SHARE, uri: REVIEW_SHELL }),
        req({ host: SHARE, uri: '/.env' }),
        req({ host: `s--${'z'.repeat(20)}.sites.example.test` }), // unknown or revoked
        req({ host: SHARE, uri: '/docs' }), // 301
        req({ host: SHARE, method: 'POST' }), // 405
      ].map(r => routeSiteRequest(r, ctx()))
    )
    expect(decisions.map(d => (d.action === 'respond' ? d.status : d.action))).toEqual([
      'rewrite',
      'rewrite',
      'rewrite',
      'rewrite',
      'rewrite',
      'rewrite',
      'rewrite',
      301,
      405,
    ])
    for (const d of decisions) expect(d.headers).toMatchObject(NO_REFERRER)
  })

  it('leaves site-name hosts and other hosts the browser default', async () => {
    for (const r of [
      req({}),
      req({ uri: '/docs' }),
      req({ method: 'POST' }),
      req({ host: 'priv.sites.example.test' }),
      req({ uri: REVIEW_SHELL }),
      req({ host: 'a--b.sites.example.test' }),
      req({ host: '' }),
    ]) {
      const d = await routeSiteRequest(r, ctx())
      expect(d.headers['referrer-policy']).toBeUndefined()
    }
    expect(siteResponseHeaders('pub.sites.example.test')).toEqual(NOINDEX)
    expect(siteResponseHeaders(SHARE)).toEqual({ ...NOINDEX, ...NO_REFERRER })
  })
})

describe('signed token kinds', () => {
  const hmac = ctx().hmac
  const x = NOW + 60
  const tokens: Record<string, string> = {
    site: signSiteCookie({ e: 'a@example.test', x }, KEY),
    pass: signSitePass({ s: 'S2', e: 'a@example.test', x }, KEY),
    handoff: signPassHandoff({ s: 'S2', e: 'a@example.test', x }, KEY),
    deny: signDenyHandoff({ s: 'S2', x }, KEY),
    denied: signSiteDenied({ s: 'S2', x }, KEY),
  }
  // What each check accepts, at the edge (site-routing.ts) and in Node (site-cookie.ts).
  const checks: Record<string, (t: string) => boolean> = {
    site: t => validSiteCookie(t, KEY, NOW, hmac) && verifySiteCookie(t, KEY, NOW) !== null,
    pass: t =>
      validSitePass(t, KEY, 'pass', 'S2', NOW, hmac) !== null &&
      verifySitePass(t, KEY, 'pass', NOW) !== null,
    handoff: t =>
      validSitePass(t, KEY, 'handoff', 'S2', NOW, hmac) !== null &&
      verifySitePass(t, KEY, 'handoff', NOW) !== null,
    deny: t =>
      validSiteDenial(t, KEY, 'deny', 'S2', NOW, hmac) &&
      verifySiteDenial(t, KEY, 'deny', NOW) !== null,
    denied: t =>
      validSiteDenial(t, KEY, 'denied', 'S2', NOW, hmac) &&
      verifySiteDenial(t, KEY, 'denied', NOW) !== null,
  }
  const either: Record<string, (t: string) => boolean> = {
    site: t => validSiteCookie(t, KEY, NOW, hmac) || verifySiteCookie(t, KEY, NOW) !== null,
    pass: t =>
      validSitePass(t, KEY, 'pass', 'S2', NOW, hmac) !== null ||
      verifySitePass(t, KEY, 'pass', NOW) !== null,
    handoff: t =>
      validSitePass(t, KEY, 'handoff', 'S2', NOW, hmac) !== null ||
      verifySitePass(t, KEY, 'handoff', NOW) !== null,
    deny: t =>
      validSiteDenial(t, KEY, 'deny', 'S2', NOW, hmac) ||
      verifySiteDenial(t, KEY, 'deny', NOW) !== null,
    denied: t =>
      validSiteDenial(t, KEY, 'denied', 'S2', NOW, hmac) ||
      verifySiteDenial(t, KEY, 'denied', NOW) !== null,
  }

  it('each check takes its own kind, at the edge and in Node alike', () => {
    for (const kind of Object.keys(tokens)) {
      expect({ kind, ok: checks[kind]?.(tokens[kind] as string) }).toEqual({ kind, ok: true })
    }
  })

  it('no check takes any other kind', () => {
    for (const [kind, token] of Object.entries(tokens)) {
      for (const [check, ok] of Object.entries(either)) {
        if (check !== kind)
          expect({ kind, check, ok: ok(token) }).toEqual({ kind, check, ok: false })
      }
    }
  })

  it('a refusal holds no email', () => {
    const body = (tokens.deny as string).split('.')[0] as string
    expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toEqual({ k: 'deny', s: 'S2', x })
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
