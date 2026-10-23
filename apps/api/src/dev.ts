/**
 * Local dev: the API on :3001 (memory store, fs storage under `.fling-dev/`, memory KVS) and the
 * sites on :3002 — `http://<label>.fling.lvh.me:3002/…` runs the real edge/site-router.js (via the
 * @fling/edge harness) against the same in-memory KVS, then serves the rewritten object from
 * `.fling-dev/`. Missing objects get apps/web/dist-404/404.html with a 404.
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSiteRouter, isResponse, toCloudFrontEvent } from '@fling/edge'
import { MISSING_KEY, SITE_HMAC_KVS_KEY } from '@fling/shared'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createApp } from './app.ts'
import { type Config, loadBaseConfig, secretsFromEnv } from './config.ts'
import { buildDeps } from './deps.ts'
import { MemoryKvs } from './kvs/memory.ts'
import { contentTypeFor } from './lib/mime.ts'

const API_PORT = Number(process.env.PORT ?? 3001)
const SITES_PORT = Number(process.env.SITES_PORT ?? 3002)
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fsRoot = resolve(repoRoot, '.fling-dev')
const notFoundPage = resolve(repoRoot, 'apps/web/dist-404/404.html')

const devSecret = () => randomBytes(32).toString('base64url')
const env = {
  APP_ENV: 'development',
  DEV_LOGIN: '1',
  // lvh.me (and every subdomain) resolves to 127.0.0.1. Browsers won't share a
  // `Domain=localhost` cookie with `*.localhost`, so private sites need a real-looking domain.
  // The UI dev server (vite, :3000 by default) proxies /api, /auth, /mcp, /oauth to this API.
  APP_ORIGIN: `http://fling.lvh.me:${process.env.UI_PORT ?? 3000}`,
  SITES_DOMAIN: `fling.lvh.me:${SITES_PORT}`,
  SITE_SCHEME: 'http',
  SITE_COOKIE_DOMAIN: 'fling.lvh.me',
  ...process.env,
  // Fresh per process is fine: the memory store forgets every session on restart anyway.
  SESSION_SECRET: process.env.SESSION_SECRET ?? devSecret(),
  SITE_HMAC_KEY: process.env.SITE_HMAC_KEY ?? devSecret(),
}

const base = loadBaseConfig(env)
const config: Config = { ...base, secrets: secretsFromEnv(env) }
const kvs = new MemoryKvs()
const deps = buildDeps(config, { fsRoot, apiBaseUrl: `http://localhost:${API_PORT}`, kvs })
await kvs.put(SITE_HMAC_KVS_KEY, config.secrets.siteHmacKey)

serve({ fetch: createApp(deps).fetch, port: API_PORT }, info =>
  console.log(`fling api   http://localhost:${info.port}  (app origin ${config.appOrigin})`)
)

const router = createSiteRouter({
  kvs,
  appOrigin: config.appOrigin,
  siteScheme: 'http',
  now: () => deps.clock.now().getTime(),
})
const sites = new Hono()

sites.all('*', async c => {
  const url = new URL(c.req.url)
  const event = toCloudFrontEvent({
    method: c.req.method,
    host: c.req.header('host') ?? url.host,
    path: url.pathname,
    query: url.search.slice(1),
    cookieHeader: c.req.header('cookie'),
  })
  const result = await router(event)
  if (isResponse(result)) {
    const headers = new Headers()
    for (const [name, v] of Object.entries(result.headers ?? {})) headers.set(name, v.value)
    return new Response(null, { status: result.statusCode, headers })
  }
  const file = resolve(fsRoot, `.${decodeURIComponent(result.uri)}`)
  if (result.uri !== MISSING_KEY && file.startsWith(fsRoot + sep)) {
    try {
      const body = await readFile(file)
      const type = contentTypeFor(file)
      return new Response(body, { headers: { 'content-type': type } })
    } catch {
      // fall through to the 404 page
    }
  }
  try {
    return c.html(await readFile(notFoundPage, 'utf8'), 404)
  } catch {
    return c.text('Not found (build apps/web for the real 404 page)', 404)
  }
})

serve({ fetch: sites.fetch, port: SITES_PORT }, info =>
  console.log(`fling sites http://<name>.fling.lvh.me:${info.port}`)
)
