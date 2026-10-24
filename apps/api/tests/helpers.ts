import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManifestFile } from '@fling/shared'
import { createApp } from '../src/app.ts'
import { mintApiKey } from '../src/auth/api-keys.ts'
import { signSession } from '../src/auth/session.ts'
import { FsBlobs } from '../src/blobs/fs.ts'
import { type Config, loadBaseConfig } from '../src/config.ts'
import { MemoryRouteTable } from '../src/route-table/memory.ts'
import { Records } from '../src/store/records.ts'
import { MemoryTable } from '../src/table/memory.ts'
import type { Deps, GoogleClaims } from '../src/types.ts'

export const APP_ORIGIN = 'https://fling.test'

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadBaseConfig({
    APP_ENV: 'production',
    APP_ORIGIN,
    SITES_DOMAIN: 'fling.test',
    SITE_SCHEME: 'https',
    SITE_COOKIE_DOMAIN: '.fling.test',
    ALLOWED_EMAIL_DOMAINS: 'nearform.com',
    STORE_DRIVER: 'memory',
    STORAGE_DRIVER: 'fs',
    KVS_DRIVER: 'memory',
  })
  return {
    ...base,
    secrets: {
      googleClientId: 'cid',
      googleClientSecret: 'csecret',
      sessionSecret: 's'.repeat(40),
      siteHmacKey: 'h'.repeat(40),
    },
    ...overrides,
  }
}

export function setup(overrides: Partial<Config> = {}) {
  const config = testConfig(overrides)
  let now = new Date('2026-01-01T00:00:00Z')
  const clock = { now: () => now }
  // Expiry in the table follows the test clock, as it follows real time in production.
  const table = new MemoryTable(() => clock.now().getTime())
  const store = new Records(table)
  const routeTable = new MemoryRouteTable()
  const root = mkdtempSync(join(tmpdir(), 'fling-api-'))
  const blobs = new FsBlobs(root, APP_ORIGIN, config.secrets.sessionSecret)
  const google: { claims: GoogleClaims; lastState?: string } = {
    claims: { email: 'alice@nearform.com', email_verified: true, hd: 'nearform.com' },
  }
  const deps: Deps = {
    config,
    store,
    blobs,
    routeTable,
    clock,
    oauth: {
      authorizationUrl(state) {
        google.lastState = state
        return new URL(`https://accounts.google.test/auth?state=${state}`)
      },
      async exchange(code) {
        if (code !== 'good-code') throw new Error('bad code')
        return google.claims
      },
    },
  }
  const app = createApp(deps)
  return {
    app,
    deps,
    config,
    store,
    table,
    routeTable,
    blobs,
    root,
    google,
    advance(ms: number) {
      now = new Date(now.getTime() + ms)
    },
  }
}

export type Env = ReturnType<typeof setup>

export async function createUser(env: Env, email = 'alice@nearform.com') {
  const user = await env.store.upsertUser(
    { email, name: 'Alice', picture: null, preferredSlug: email.split('@')[0] ?? 'u' },
    env.deps.clock.now().toISOString()
  )
  const { plaintext } = await mintApiKey(env.store, email, 'cli:test', env.deps.clock.now())
  const session = await signSession(email, env.config.secrets.sessionSecret, env.deps.clock.now())
  return { user, key: plaintext, session }
}

/** Bearer-authenticated JSON request. */
export function api(env: Env, key: string, method: string, path: string, body?: unknown) {
  return env.app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function file(
  path: string,
  content: string,
  contentType = 'text/html'
): {
  meta: ManifestFile
  content: string
} {
  return {
    meta: {
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
      size: Buffer.byteLength(content),
      contentType,
    },
    content,
  }
}

/** Do the client's half of an upload: PUT each presigned URL against the app. */
export async function upload(
  env: Env,
  uploads: { path: string; url: string; headers: Record<string, string> }[],
  files: { meta: ManifestFile; content: string }[]
) {
  for (const u of uploads) {
    const f = files.find(x => x.meta.path === u.path)
    if (!f) throw new Error(`no file ${u.path}`)
    const res = await env.app.request(u.url, { method: 'PUT', headers: u.headers, body: f.content })
    if (res.status !== 200) throw new Error(`upload ${u.path} → ${res.status}`)
  }
}

export async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T
}
