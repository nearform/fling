// The route table's two formats (kvs.ts RouteFormat): every value reads back the same from either,
// and the routing decision is the same whichever the table holds, share links (a pointer in
// `compact`) included.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  encodePathValue,
  encodeShareValue,
  encodeSiteValue,
  type KvsSiteValue,
  ROUTE_FORMATS,
  type RouteFormat,
} from '../src/kvs.ts'
import { pathKvsKey, shareKvsKey, siteKvsKey } from '../src/route-keys.ts'
import { parseRoute, routeSiteRequest, type SiteRequest } from '../src/site-routing.ts'

/** What routing reads of a value: its fields, an unset visibility being private. */
function read(raw: string) {
  const r = parseRoute(raw) as Record<string, unknown> | null
  if (!r) return null
  const out: Record<string, unknown> = { vis: r.vis ?? 'private', spa: !!r.spa }
  for (const k of ['id', 'v', 'r', 'p', 'i', 'm', 'f', 't', 'x'])
    if (r[k] !== undefined) out[k] = r[k]
  return out
}

const base: KvsSiteValue = { id: 'abcdefghijkl', v: '0123456789abcdef', vis: 'private', spa: false }

/** Every combination of the optional fields, and both visibilities and SPA settings. */
function values(): KvsSiteValue[] {
  const out: KvsSiteValue[] = []
  for (let bits = 0; bits < 1 << 9; bits++) {
    const on = (n: number) => (bits & (1 << n)) !== 0
    out.push({
      ...base,
      vis: on(0) ? 'public' : 'private',
      spa: on(1),
      ...(on(2) ? { r: 1 as const } : {}),
      ...(on(3) ? { p: 1 as const } : {}),
      ...(on(4) ? { i: 'f00dfeedf00dfeed' } : {}),
      ...(on(5) ? { m: 1 as const } : {}),
      ...(on(6) ? { f: 1 as const } : {}),
      ...(on(7) ? { t: 'https://abc.lambda-url.us-east-1.on.aws/x|y' } : {}),
      ...(on(8) ? { x: 1 as const } : {}),
    })
  }
  return out
}

describe('route values', () => {
  it('read back the same from either format, for every combination of fields', () => {
    for (const v of values()) {
      expect(read(encodeSiteValue(v, 'compact'))).toEqual(read(encodeSiteValue(v, 'json')))
    }
  })

  it('a Path value reads back the same from either format', () => {
    for (const v of [
      { id: 'pathidpathid', v: 'w1w1w1w1w1w1w1w1' },
      { id: 'pathidpathid', v: 'w1w1w1w1w1w1w1w1', m: 1 as const },
    ]) {
      expect(read(encodePathValue(v, 'compact'))).toEqual(read(encodePathValue(v, 'json')))
    }
  })

  it('compact is under half the size of json', () => {
    const json = encodeSiteValue(base, 'json')
    const compact = encodeSiteValue(base, 'compact')
    expect(compact).toBe('~abcdefghijkl|0123456789abcdef')
    expect(compact.length * 2).toBeLessThan(json.length)
  })

  it('anything else reads as no route', () => {
    for (const raw of ['', '{', 'nonsense', null]) {
      expect(parseRoute(raw) === null || parseRoute(raw)?.id === undefined).toBe(true)
    }
  })
})

const TOKEN = 't'.repeat(20)
const sites: Record<string, KvsSiteValue> = {
  pub: { id: 'S1', v: 'V1', vis: 'public', spa: false },
  spa: { id: 'S2', v: 'V2', vis: 'public', spa: true },
  priv: { id: 'S3', v: 'V3', vis: 'private', spa: false },
  team: { id: 'S5', v: 'V5', vis: 'public', spa: false, p: 1, i: 'R5', m: 1 },
  srv: { id: 'S7', v: 'V7', vis: 'public', spa: false, f: 1, t: 'https://fn.example/x' },
  stopped: { id: 'S8', v: 'V8', vis: 'public', spa: false, f: 1, x: 1 },
}

function table(format: RouteFormat) {
  const routes = new Map<string, string>()
  for (const [label, value] of Object.entries(sites)) {
    const encoded = encodeSiteValue(value, format)
    routes.set(siteKvsKey(label), encoded)
    if (label === 'priv') routes.set(shareKvsKey(TOKEN), encodeShareValue(label, encoded, format))
  }
  routes.set(pathKvsKey('S5', 'PAY-1'), encodePathValue({ id: 'P1', v: 'W1', m: 1 }, format))
  return routes
}

const ctx = (routes: Map<string, string>) => ({
  appOrigin: 'https://app.example.test',
  siteScheme: 'https',
  nowSeconds: 1_800_000_000,
  getRoute: async (key: string) => routes.get(key) ?? null,
  getCookieKey: async () => 'k'.repeat(40),
  getRevocation: async () => null,
  hmac: (key: string, data: string) => createHmac('sha256', key).update(data).digest('base64url'),
})

const request = (host: string, uri: string, method = 'GET'): SiteRequest => ({
  method,
  host: `${host}.sites.example.test`,
  uri,
  query: '',
  cookie: null,
  pass: null,
})

describe('the routing decision', () => {
  const hosts = [...Object.keys(sites), `s--${TOKEN}`, 'missing']
  const uris = [
    '/',
    '/index.html',
    '/a/b',
    '/PAY-1/',
    '/PAY-1',
    '/notes.md',
    '/api/x',
    '/_fling-version',
  ]

  it('is the same whichever format the table holds', async () => {
    const [json, compact] = ROUTE_FORMATS.map(f => ctx(table(f)))
    for (const host of hosts) {
      for (const uri of uris) {
        for (const method of ['GET', 'POST']) {
          const r = request(host, uri, method)
          expect(await routeSiteRequest(r, compact as never)).toEqual(
            await routeSiteRequest(r, json as never)
          )
        }
      }
    }
  })
})
