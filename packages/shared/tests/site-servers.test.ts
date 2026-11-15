// The routing decision for site servers (`f: 1`): `/api/*` invokes the version's server after every
// access check; everything else keeps the static rules. And the helpers every runtime shares.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MISSING_KEY, revokedKvsKey, SERVER_SITE_HEADER, VIEWER_HEADER } from '../src/route-keys.ts'
import { revocationMac, signSiteCookie, signSitePass } from '../src/site-cookie.ts'
import { routeSiteRequest, type SiteRequest, viewerIdOf } from '../src/site-routing.ts'
import {
  formatLogLine,
  parseViewerHeader,
  serverCacheControl,
  serverFilePath,
  serverRequestHeaders,
  unbundledImports,
  viewerHeaderOf,
} from '../src/site-server.ts'

const KEY = 'k'.repeat(40)
const NOW = 1_800_000_000
const route = (value: object) => JSON.stringify(value)
const routes = new Map([
  ['site:fn', route({ id: 'S1', v: 'V1', vis: 'public', spa: false, f: 1 })],
  ['site:fnpriv', route({ id: 'S2', v: 'V2', vis: 'private', spa: false, f: 1 })],
  ['site:fnres', route({ id: 'S3', v: 'V3', vis: 'private', spa: false, f: 1, r: 1 })],
  ['site:plain', route({ id: 'S4', v: 'V4', vis: 'public', spa: false })],
  ['site:fnaws', route({ id: 'S5', v: 'V5', vis: 'public', spa: false, f: 1, t: 'x.on.aws' })],
  ['site:fnstop', route({ id: 'S6', v: 'V6', vis: 'public', spa: false, f: 1, x: 1 })],
  [`share:${'t'.repeat(20)}`, route({ id: 'S2', v: 'V2', vis: 'private', spa: false, f: 1 })],
])
const hmac = (key: string, data: string) =>
  createHmac('sha256', key).update(data).digest('base64url')
const revoked = new Map<string, string>()
const ctx = {
  appOrigin: 'https://app.example.test',
  siteScheme: 'https',
  nowSeconds: NOW,
  getRoute: async (key: string) => routes.get(key) ?? null,
  getCookieKey: async () => KEY,
  getRevocation: async (key: string) => revoked.get(key) ?? null,
  hmac,
}
const req = (over: Partial<SiteRequest>): SiteRequest => ({
  method: 'GET',
  host: 'fn.sites.example.test',
  uri: '/api/hello',
  query: '',
  cookie: null,
  pass: null,
  ...over,
})
const member = (email = 'ada@example.test', extra: object = {}) =>
  signSiteCookie({ e: email, x: NOW + 600, ...extra } as never, KEY)

describe('invoke', () => {
  it("invokes the version's server for /api/*, any method, with no viewer on a public site", async () => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const d = await routeSiteRequest(req({ method }), ctx)
      expect(d).toMatchObject({
        action: 'invoke',
        siteId: 'S1',
        v: 'V1',
        target: null,
        private: false,
        viewer: null,
      })
    }
  })

  it('carries the target the route value names', async () => {
    const d = await routeSiteRequest(req({ host: 'fnaws.sites.example.test' }), ctx)
    expect(d).toMatchObject({ action: 'invoke', target: 'x.on.aws' })
  })

  it('serves files outside /api/ and refuses other methods there, before any lookup', async () => {
    expect(await routeSiteRequest(req({ uri: '/app.js' }), ctx)).toMatchObject({
      action: 'rewrite',
      uri: '/sites/S1/V1/app.js',
    })
    let lookups = 0
    const counting = { ...ctx, getRoute: async (k: string) => (lookups++, routes.get(k) ?? null) }
    expect(
      await routeSiteRequest(req({ uri: '/contact', method: 'POST' }), counting)
    ).toMatchObject({ status: 405 })
    expect(lookups).toBe(0)
  })

  it('treats /api/ as a folder on a site without a server', async () => {
    const host = 'plain.sites.example.test'
    expect(await routeSiteRequest(req({ host, uri: '/api/data.json' }), ctx)).toMatchObject({
      action: 'rewrite',
      uri: '/sites/S4/V4/api/data.json',
    })
    expect(await routeSiteRequest(req({ host, method: 'POST' }), ctx)).toMatchObject({
      status: 405,
    })
  })

  it('never serves anything under /_fling/ from a site, the bundle included', async () => {
    for (const uri of ['/_fling/server.mjs', '/_fling/other.js', '/_fling/']) {
      expect(await routeSiteRequest(req({ uri }), ctx)).toMatchObject({
        action: 'rewrite',
        uri: MISSING_KEY,
      })
    }
  })

  it('answers 503 for a server an admin stopped, after the access checks', async () => {
    const d = await routeSiteRequest(req({ host: 'fnstop.sites.example.test' }), ctx)
    expect(d).toMatchObject({ action: 'respond', status: 503 })
    expect(JSON.parse((d as { body: string }).body).error.code).toBe('server_stopped')
  })
})

describe('cross-origin writes', () => {
  const own = 'https://fn.sites.example.test'
  const refused = async (over: Partial<SiteRequest>) => {
    const d = await routeSiteRequest(req({ method: 'POST', ...over }), ctx)
    return d.action === 'respond' && d.status === 403
  }

  it('lets a write from the site itself through', async () => {
    expect(await refused({ fetchSite: 'same-origin' })).toBe(false)
    expect(await refused({ origin: own })).toBe(false)
    expect(await refused({ fetchSite: 'same-origin', origin: own })).toBe(false)
  })

  it('lets a request with neither header through: it carries no browser cookies', async () => {
    expect(await refused({})).toBe(false)
  })

  it("refuses another site's page, even on the same sites domain", async () => {
    expect(
      await refused({ fetchSite: 'same-site', origin: 'https://evil.sites.example.test' })
    ).toBe(true)
    expect(await refused({ fetchSite: 'cross-site' })).toBe(true)
    expect(await refused({ origin: 'https://evil.example' })).toBe(true)
    const d = await routeSiteRequest(req({ method: 'POST', fetchSite: 'cross-site' }), ctx)
    expect(JSON.parse((d as { body: string }).body).error.code).toBe('cross_origin')
  })

  it('never refuses reads or preflights', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const d = await routeSiteRequest(req({ method, fetchSite: 'cross-site' }), ctx)
      expect(d.action).toBe('invoke')
    }
  })
})

describe('the viewer', () => {
  it("sends a private site's API to sign in without a cookie, and names the member with one", async () => {
    const host = 'fnpriv.sites.example.test'
    expect(await routeSiteRequest(req({ host }), ctx)).toMatchObject({ status: 302 })
    const d = await routeSiteRequest(req({ host, cookie: member(), method: 'POST' }), ctx)
    expect(d).toMatchObject({
      action: 'invoke',
      private: true,
      viewer: {
        id: viewerIdOf(KEY, 'S2', 'ada@example.test', hmac),
        email: 'ada@example.test',
        guest: false,
      },
    })
  })

  it('keeps a revoked member out of the API as out of the pages', async () => {
    const host = 'fnpriv.sites.example.test'
    revoked.set(revokedKvsKey(revocationMac('gone@example.test', KEY)), String(NOW + 9999))
    const d = await routeSiteRequest(req({ host, cookie: member('gone@example.test') }), ctx)
    expect(d).toMatchObject({ status: 302 })
  })

  it("names the holder of a restricted site's pass, and whether they are a guest", async () => {
    const host = 'fnres.sites.example.test'
    expect(await routeSiteRequest(req({ host }), ctx)).toMatchObject({ status: 302 })
    const pass = signSitePass({ s: 'S3', e: 'grace@example.test', x: NOW + 600 }, KEY)
    expect(await routeSiteRequest(req({ host, pass }), ctx)).toMatchObject({
      action: 'invoke',
      viewer: { email: 'grace@example.test', guest: false },
    })
    const cookie = member('grace@example.test', { g: 1 })
    expect(await routeSiteRequest(req({ host, pass, cookie }), ctx)).toMatchObject({
      action: 'invoke',
      viewer: { email: 'grace@example.test', guest: true },
    })
  })

  it('gives no viewer through a share link, as on a public site', async () => {
    const host = `s--${'t'.repeat(20)}.sites.example.test`
    expect(await routeSiteRequest(req({ host, cookie: member() }), ctx)).toMatchObject({
      action: 'invoke',
      siteId: 'S2',
      viewer: null,
    })
  })

  it('gives one person one id per site, a different one on each site, and no address', () => {
    const a = viewerIdOf(KEY, 'S1', 'ada@example.test', hmac)
    expect(a).toMatch(/^v_[a-z2-7]{13}$/)
    expect(viewerIdOf(KEY, 'S1', 'ada@example.test', hmac)).toBe(a)
    expect(viewerIdOf(KEY, 'S2', 'ada@example.test', hmac)).not.toBe(a)
    expect(viewerIdOf(KEY, 'S1', 'bob@example.test', hmac)).not.toBe(a)
  })
})

describe('what a server receives', () => {
  it('drops cookies, credentials and a forged viewer, and sets the decision’s', () => {
    const viewer = { id: 'v_x', email: 'ada@example.test', guest: false }
    const out = serverRequestHeaders(
      new Headers({
        cookie: 'fling_site=x',
        authorization: 'Bearer y',
        [VIEWER_HEADER]: '{"id":"v_forged","email":"boss@example.test","guest":false}',
        'content-type': 'application/json',
      }),
      { siteId: 'S1', v: 'V1', viewer }
    )
    expect(out.get('cookie')).toBeNull()
    expect(out.get('authorization')).toBeNull()
    expect(parseViewerHeader(out.get(VIEWER_HEADER))).toEqual(viewer)
    expect(out.get(SERVER_SITE_HEADER)).toBe('S1/V1')
    expect(out.get('content-type')).toBe('application/json')
    const anonymous = serverRequestHeaders(new Headers({ [VIEWER_HEADER]: '{"id":"v"}' }), {
      siteId: 'S1',
      v: 'V1',
      viewer: null,
    })
    expect(anonymous.get(VIEWER_HEADER)).toBeNull()
  })

  it('reads the viewer from a fetch Request or a Node request', () => {
    const value = '{"id":"v_a","email":"a@example.test","guest":true}'
    const fromFetch = new Request('http://x/', { headers: { [VIEWER_HEADER]: value } })
    expect(parseViewerHeader(viewerHeaderOf(fromFetch))?.guest).toBe(true)
    expect(viewerHeaderOf({ headers: { [VIEWER_HEADER]: value } })).toBe(value)
    expect(parseViewerHeader('not json')).toBeNull()
    expect(parseViewerHeader('{"email":"a@example.test"}')).toBeNull()
    expect(parseViewerHeader(null)).toBeNull()
  })
})

describe('caching', () => {
  it('adds private, no-store when the author set nothing', () => {
    expect(serverCacheControl(null, false)).toBe('private, no-store')
    expect(serverCacheControl('', true)).toBe('private, no-store')
  })

  it("keeps the author's on a public site, and makes public private on a private one", () => {
    expect(serverCacheControl('public, max-age=60', false)).toBe('public, max-age=60')
    expect(serverCacheControl('public, max-age=60, s-maxage=600', true)).toBe('private, max-age=60')
    expect(serverCacheControl('no-cache', true)).toBe('no-cache')
  })
})

describe('admission helpers', () => {
  const helper = '@example/fling/server'

  it('finds the imports a bundle may not make', () => {
    const bundle = [
      'import{createServer as a}from"node:http";',
      `import{viewer as v}from"${helper}";`,
      'import x from"hono";import"./side.js";',
      'export{z}from"zod";const m=await import("lodash");',
      'const c=require("crypto");',
    ].join('')
    expect(unbundledImports(bundle, helper)).toEqual([
      'hono',
      './side.js',
      'zod',
      'lodash',
      'crypto',
    ])
  })

  it('takes a bundle that imports only node:* and the helpers', () => {
    const bundle = `import{a}from"node:crypto";import*as h from"${helper}";export default{fetch(){return a}}`
    expect(unbundledImports(bundle, helper)).toEqual([])
    // A property or a word ending in "import" is not an import.
    expect(unbundledImports('x.import("y");reimport("z")', helper)).toEqual([])
  })

  it('lets file() read only published files of the version', () => {
    expect(serverFilePath('/data/rates.json')).toBe('data/rates.json')
    for (const bad of ['_fling/server.mjs', '.env', 'a/../b', 'a//b', '', '/']) {
      expect(serverFilePath(bad), bad).toBeNull()
    }
  })

  it('prints a request line as fling logs shows it', () => {
    expect(
      formatLogLine({
        at: '2026-11-15T06:12:03.000Z',
        versionId: 'V5',
        kind: 'request',
        method: 'POST',
        path: '/api/request',
        status: 200,
        ms: 412.3,
        viewer: 'v_abc',
      })
    ).toBe('06:12:03  POST /api/request  200  412 ms  v_abc  version V5')
  })
})
