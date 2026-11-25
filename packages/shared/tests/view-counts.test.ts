// View counts in the shared contracts: the routing decision for SITE_SEEN_PATH and the counted
// copies (route value `c`), the route formats carrying `c`, the beacon's placement and the
// metrics' buckets.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  encodePathValue,
  encodeSiteValue,
  type KvsPathValue,
  type KvsSiteValue,
} from '../src/kvs.ts'
import {
  dayOf,
  METRIC_DAYS,
  METRIC_MONTHS,
  METRIC_WEEKS,
  metricRanges,
  weekOf,
  weekStartOf,
} from '../src/metrics.ts'
import { COUNTED_DIR, MISSING_KEY, pathKvsKey, SITE_SEEN_PATH } from '../src/route-keys.ts'
import { signSiteCookie } from '../src/site-cookie.ts'
import { parseRoute, routeSiteRequest, type SiteRequest } from '../src/site-routing.ts'
import { carriesViewBeacon, VIEW_BEACON, withViewBeacon } from '../src/view-beacon.ts'

const KEY = 'k'.repeat(40)
const NOW = 1_800_000_000
const hmac = (key: string, data: string) =>
  createHmac('sha256', key).update(data).digest('base64url')
const routes = new Map([
  ['site:pub', JSON.stringify({ id: 'S1', v: 'V1', vis: 'public', spa: false, c: 1 })],
  ['site:plain', JSON.stringify({ id: 'S2', v: 'V2', vis: 'public', spa: false })],
  ['site:priv', JSON.stringify({ id: 'S3', v: 'V3', vis: 'private', spa: true, c: 1 })],
  [
    'site:srv',
    JSON.stringify({ id: 'S4', v: 'V4', vis: 'public', spa: false, f: 1, t: 'x.on.aws', x: 1 }),
  ],
  ['site:docs', JSON.stringify({ id: 'S5', v: 'V5', vis: 'public', spa: false, m: 1, c: 1 })],
  ['site:team', JSON.stringify({ id: 'S6', v: 'V6', vis: 'public', spa: false, p: 1 })],
  [pathKvsKey('S6', 'PAY-1'), JSON.stringify({ id: 'P1', v: 'W1', c: 1 })],
])
const ctx = {
  appOrigin: 'https://app.example.test',
  siteScheme: 'https',
  nowSeconds: NOW,
  getRoute: async (key: string) => routes.get(key) ?? null,
  getCookieKey: async () => KEY,
  getRevocation: async () => null,
  hmac,
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
const beacon = (host: string, over: Partial<SiteRequest> = {}) =>
  routeSiteRequest(
    req({
      method: 'POST',
      host,
      uri: SITE_SEEN_PATH,
      fetchSite: 'same-origin',
      origin: `https://${host}`,
      ...over,
    }),
    ctx
  )

describe('the view beacon path', () => {
  it('is an invoke with no target on any site, with or without counted copies', async () => {
    for (const [host, siteId] of [
      ['pub.sites.example.test', 'S1'],
      ['plain.sites.example.test', 'S2'],
    ]) {
      expect(await beacon(host)).toMatchObject({
        action: 'invoke',
        siteId,
        target: null,
        viewer: null,
      })
    }
  })

  it("never reaches a site's server, stopped or not", async () => {
    expect(await beacon('srv.sites.example.test')).toMatchObject({
      action: 'invoke',
      siteId: 'S4',
      target: null,
    })
  })

  it('passes the access checks of a page first', async () => {
    const denied = await beacon('priv.sites.example.test')
    expect(denied).toMatchObject({ action: 'respond', status: 302 })
    const cookie = signSiteCookie({ e: 'a@example.test', x: NOW + 1 }, KEY)
    const viewed = await beacon('priv.sites.example.test', { cookie })
    expect(viewed).toMatchObject({ action: 'invoke', siteId: 'S3', target: null, private: true })
    expect(await beacon('nope.sites.example.test')).toMatchObject({ uri: MISSING_KEY })
  })

  it("refuses a post from another site's page", async () => {
    const d = await beacon('pub.sites.example.test', {
      fetchSite: 'same-site',
      origin: 'https://other.sites.example.test',
    })
    expect(d).toMatchObject({ action: 'respond', status: 403 })
  })
})

describe('counted copies', () => {
  const at = (uri: string, host = 'pub.sites.example.test', query = '') =>
    routeSiteRequest(req({ host, uri, query }), ctx)

  it("serves an HTML page's copy while the route says c, and every other file as it is", async () => {
    expect(await at('/')).toMatchObject({ uri: '/sites/S1/V1/.counted/index.html' })
    expect(await at('/a/page.HTM')).toMatchObject({ uri: '/sites/S1/V1/.counted/a/page.HTM' })
    expect(await at('/app.css')).toMatchObject({ uri: '/sites/S1/V1/app.css' })
    expect(await at('/', 'plain.sites.example.test')).toMatchObject({
      uri: '/sites/S2/V2/index.html',
    })
    expect(`/${COUNTED_DIR}`).toBe('/.counted/')
  })

  it("serves an SPA's fallback from its copy", async () => {
    const cookie = signSiteCookie({ e: 'a@example.test', x: NOW + 1 }, KEY)
    const d = await routeSiteRequest(
      req({ host: 'priv.sites.example.test', uri: '/deep/route', cookie }),
      ctx
    )
    expect(d).toMatchObject({ uri: '/sites/S3/V3/.counted/index.html' })
  })

  it('serves rendered Markdown, which carries the beacon itself, over a copy', async () => {
    expect(await at('/plan.md', 'docs.sites.example.test')).toMatchObject({
      uri: '/sites/S5/V5/.rendered/plan.md.html',
    })
  })

  it("serves a Path's copies by the Path's own route", async () => {
    expect(await at('/PAY-1/', 'team.sites.example.test')).toMatchObject({
      uri: '/sites/P1/W1/.counted/index.html',
    })
    expect(await at('/', 'team.sites.example.test')).toMatchObject({
      uri: '/sites/S6/V6/index.html',
    })
  })
})

describe('the c flag in route values', () => {
  const site: KvsSiteValue = { id: 'S1', v: 'V1', vis: 'public', spa: false, m: 1, c: 1 }
  const path: KvsPathValue = { id: 'P1', v: 'W1', m: 1, c: 1 }

  it('reads back from both formats', () => {
    for (const format of ['json', 'compact'] as const) {
      expect(parseRoute(encodeSiteValue(site, format))).toMatchObject({ m: 1, c: 1 })
      expect(parseRoute(encodePathValue(path, format))).toMatchObject({ m: 1, c: 1 })
      expect(parseRoute(encodePathValue({ id: 'P1', v: 'W1', c: 1 }, format))).toMatchObject({
        c: 1,
      })
    }
    expect(encodePathValue(path, 'compact')).toBe('~P1|W1|mc')
  })
})

describe('withViewBeacon', () => {
  it('puts the beacon before the last </body>, whatever its case', () => {
    expect(withViewBeacon('<body><p>a</p></BODY></html>')).toBe(
      `<body><p>a</p>${VIEW_BEACON}</BODY></html>`
    )
    expect(withViewBeacon('<p>x</p></body><!-- </body> -->')).toBe(
      `<p>x</p></body><!-- ${VIEW_BEACON}</body> -->`
    )
  })

  it('adds it at the end of a page without a </body>', () => {
    expect(withViewBeacon('<p>a</p>')).toBe(`<p>a</p>${VIEW_BEACON}`)
  })

  it('posts to the beacon path and nothing else', () => {
    expect(VIEW_BEACON).toContain(`sendBeacon("${SITE_SEEN_PATH}")`)
    expect(VIEW_BEACON).not.toMatch(/cookie|location\.href|referrer/)
  })
})

describe('carriesViewBeacon', () => {
  const script = (textContent: string | null) => ({ textContent })
  it("finds the beacon among a page's scripts", () => {
    const inner = VIEW_BEACON.replace(/^<script>|<\/script>$/g, '')
    expect(carriesViewBeacon([script('let a = 1'), script(inner)])).toBe(true)
  })

  it('finds any script that posts to the beacon path', () => {
    expect(carriesViewBeacon([script(`navigator.sendBeacon("${SITE_SEEN_PATH}",x)`)])).toBe(true)
  })

  it('is false for a page without one', () => {
    expect(carriesViewBeacon([])).toBe(false)
    expect(carriesViewBeacon([script(null), script('fetch("/api/x")')])).toBe(false)
  })
})

describe('metric buckets', () => {
  it('names ISO weeks by the year their Thursday is in', () => {
    expect(weekOf(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01')
    expect(weekOf(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01')
    expect(weekOf(new Date('2027-01-01T23:59:59Z'))).toBe('2026-W53')
    expect(weekOf(new Date('2026-11-22T10:00:00Z'))).toBe('2026-W47')
    expect(dayOf(weekStartOf(new Date('2026-11-22T10:00:00Z')))).toBe('2026-11-16')
  })

  it('reads back every bucket of each range, oldest first, the current one last', () => {
    const r = metricRanges(new Date('2026-03-01T08:00:00Z'))
    expect(r.days).toHaveLength(METRIC_DAYS)
    expect(r.days.at(-1)).toBe('2026-03-01')
    expect(r.days[0]).toBe('2026-02-02')
    expect(r.weeks).toHaveLength(METRIC_WEEKS)
    expect(r.weeks.at(-1)).toEqual({ week: '2026-W09', start: '2026-02-23' })
    expect(r.months).toHaveLength(METRIC_MONTHS)
    expect(r.months[0]).toBe('2025-04')
    expect(r.months.at(-1)).toBe('2026-03')
  })
})
