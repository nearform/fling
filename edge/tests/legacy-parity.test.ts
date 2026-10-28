/**
 * Proof that the generated router decides exactly as the hand-written one it replaced
 * (tests/fixtures/site-router.legacy.js, edge/src/site-router.js as of 86d595e): both run on the
 * same events over a matrix of hosts, paths, queries, methods, cookies and route-table states, and
 * every result (rewritten request or response) must be identical, except for the headers added
 * since (every answer's `X-Robots-Tag: noindex`, a share host's `Referrer-Policy: no-referrer`),
 * checked and then set aside. `/robots.txt`, rewritten since, is not in the matrix.
 */
import nodeCrypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SITE_HMAC_KVS_KEY, shareKvsKey, siteKvsKey } from '@fling/shared/kvs'
import { signSiteCookie } from '@fling/shared/site-cookie'
import { routeKeyForHost } from '@fling/shared/site-routing'
import { describe, expect, it } from 'vitest'
import { type CloudFrontEvent, createSiteRouter, isResponse, toCloudFrontEvent } from '../index.mjs'

const LEGACY = readFileSync(new URL('./fixtures/site-router.legacy.js', import.meta.url), 'utf8')

/** The old harness: evaluate the legacy source with stubs for its imports. */
function legacyRouter(opts: {
  kvs: { get(key: string): Promise<string | undefined> }
  appOrigin: string
  siteScheme: string
  now: () => number
}) {
  const body = LEGACY.replaceAll('__APP_ORIGIN__', opts.appOrigin)
    .replaceAll('__SITE_SCHEME__', opts.siteScheme)
    .replace(/^import cf from 'cloudfront'\s*$/m, '')
    .replace(/^import crypto from 'crypto'\s*$/m, '')
  const cf = {
    kvs: () => ({
      async get(key: string) {
        const value = await opts.kvs.get(key)
        if (value === undefined || value === null) throw new Error(`Key ${key} not found`)
        return value
      },
    }),
  }
  const factory = new Function('cf', 'crypto', 'Date', 'Buffer', `${body}\nreturn handler`)
  const handler = factory(cf, nodeCrypto, { now: opts.now }, Buffer)
  return (event: CloudFrontEvent) => handler(structuredClone(event))
}

const HMAC = 'parity-hmac-key'
const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000
const TOKEN = 'abcdefghij0123456789'
const DOMAIN = 'sites.example.test'

const route = (id: string, vis: string, spa: boolean) =>
  JSON.stringify({ id, v: `V-${id}`, vis, spa })

const STATES: Record<string, Map<string, string>> = {
  full: new Map([
    [SITE_HMAC_KVS_KEY, HMAC],
    [siteKvsKey('pub'), route('S1', 'public', false)],
    [siteKvsKey('priv'), route('S2', 'private', false)],
    [siteKvsKey('spa'), route('S3', 'public', true)],
    [siteKvsKey('privspa'), route('S4', 'private', true)],
    [siteKvsKey('www'), route('S5', 'public', false)],
    [siteKvsKey('broken'), '{not json'],
    [siteKvsKey('noid'), JSON.stringify({ v: 'V', vis: 'public', spa: false })],
    [siteKvsKey('weird'), JSON.stringify({ id: 'S6', v: 'V6' })],
    [shareKvsKey(TOKEN), route('S2', 'private', false)],
  ]),
  'no hmac key': new Map([
    [siteKvsKey('priv'), route('S2', 'private', false)],
    [siteKvsKey('pub'), route('S1', 'public', false)],
  ]),
  empty: new Map(),
}

const LABELS = [
  'pub',
  'priv',
  'spa',
  'privspa',
  'www',
  'broken',
  'noid',
  'weird',
  'nope',
  'PUB',
  'Priv',
  `s--${TOKEN}`,
  `S--${TOKEN.toUpperCase()}`,
  `s--${TOKEN}x`,
  `s-${TOKEN}`,
  'a--b',
  'pub-',
  '-pub',
  'a'.repeat(51),
  '_x_',
]
const HOSTS = [
  ...LABELS.map(l => `${l}.${DOMAIN}`),
  'pub.localhost:47102',
  'priv.sites.example.test:8443',
  DOMAIN,
  '',
]
const PATHS = [
  '/',
  '/index.html',
  '/docs',
  '/docs/',
  '/a.b/c',
  '/a%20b.png',
  '/.env',
  '/a/.git/config',
  '/%2e%2E/x',
  '/_fling/404.html',
  '/_fling/missing',
  '/users/42',
]
const QUERIES = [undefined, 'a=1&a=2&b', 'x=%20y']
const cookieOf = (payload: { e: string; x: number }, key = HMAC) =>
  `fling_site=${signSiteCookie(payload, key)}`
const COOKIES = [
  undefined,
  cookieOf({ e: 'a@example.test', x: NOW_S + 60 }),
  cookieOf({ e: 'a@example.test', x: NOW_S }),
  cookieOf({ e: 'a@example.test', x: NOW_S + 60 }, 'wrong'),
  'fling_site=',
  'fling_site=garbage.x',
  `other=1; ${cookieOf({ e: 'b@example.test', x: NOW_S + 999 })}`,
]
const METHODS = ['GET', 'HEAD', 'POST', 'OPTIONS']

describe('the generated router decides exactly as the legacy one', () => {
  for (const [stateName, state] of Object.entries(STATES)) {
    for (const [appOrigin, siteScheme] of [
      ['https://fling.example.test', 'https'],
      ['http://fling.lvh.me:47100', 'http'],
    ] as const) {
      it(`${stateName}, ${siteScheme}`, async () => {
        const kvs = { get: async (key: string) => state.get(key) }
        const opts = { kvs, appOrigin, siteScheme, now: () => NOW_MS }
        const legacy = legacyRouter(opts)
        const current = createSiteRouter(opts)
        let compared = 0
        for (const host of HOSTS)
          for (const path of PATHS)
            for (const query of QUERIES)
              for (const cookieHeader of COOKIES) {
                const methods = path === '/' && query === undefined ? METHODS : ['GET']
                for (const method of methods) {
                  const event = toCloudFrontEvent({ method, host, path, query, cookieHeader })
                  if (!host) delete (event.request.headers as Record<string, unknown>).host
                  const [was, now] = [await legacy(event), await current(event)]
                  const label = JSON.stringify({ method, host, path, query, cookieHeader })
                  if (isResponse(now)) {
                    const policy = now.headers?.['referrer-policy']
                    const share = routeKeyForHost(host)?.share === true
                    expect(policy, label).toEqual(share ? { value: 'no-referrer' } : undefined)
                    expect(now.headers?.['x-robots-tag'], label).toEqual({ value: 'noindex' })
                    delete now.headers?.['referrer-policy']
                    delete now.headers?.['x-robots-tag']
                  }
                  expect(now, label).toEqual(was)
                  compared++
                }
              }
        expect(compared).toBeGreaterThan(5000)
      })
    }
  }
})
