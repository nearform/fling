/** Shared test helpers: temp config dirs and folders, a routing fetch mock, an in-memory context. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { InstanceMetadata, Site } from '@fling/shared'
import type { FetchLike } from '../src/api.ts'
import { type ConfigStore, createConfigStore } from '../src/config.ts'
import type { CommandContext } from '../src/context.ts'
import { createMemoryLogger } from '../src/utils/logger.ts'
import { createMemoryOutput } from '../src/utils/output.ts'

export const SERVER = 'http://server.test'
export const TEST_KEY = 'fling_test_0123456789abcdefghijklmnopqrstuvwxyz'

/** What SERVER says at /.well-known/fling: sites on their own domain, one allowed email domain. */
export const INSTANCE: InstanceMetadata = {
  version: 1,
  name: 'Example Fling',
  appOrigin: SERVER,
  sitesDomain: 'sites.example.test',
  siteScheme: 'https',
  auth: {
    kind: 'oidc',
    issuer: 'https://sso.example.test',
    displayName: 'Example SSO',
    emailDomains: ['example.test'],
  },
  brand: { colors: {} },
  capabilities: { remoteMcp: true },
  installCommand: 'npm install -g fling-cli',
}

/** A mockFetch route answering /.well-known/fling with INSTANCE. */
export const instanceRoute = { 'GET /.well-known/fling': () => jsonResponse(INSTANCE) }

const cleanups: (() => Promise<void>)[] = []
export async function runCleanups() {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
}

export async function tempDir(prefix = 'fling-cli-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Write `{ 'a/b.txt': 'content' }` under `root`. */
export async function writeTree(root: string, files: Record<string, string | Buffer>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

export async function tempStore(env: Record<string, string | undefined> = {}) {
  const dir = await tempDir()
  const store = createConfigStore({ dir: join(dir, '.fling'), env })
  return { dir, store }
}

export async function loggedInStore() {
  const { store } = await tempStore()
  await store.putServer(SERVER, { instance: INSTANCE, apiKey: TEST_KEY })
  return store
}

/** Write a config file as-is (an older shape, or a broken one). */
export async function writeConfig(store: ConfigStore, json: unknown) {
  await mkdir(store.dir, { recursive: true })
  await writeFile(store.file, typeof json === 'string' ? json : JSON.stringify(json))
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response>

/** A fetch that dispatches on `METHOD pathname` (or pathname) and records every call. */
export function mockFetch(routes: Record<string, Route>) {
  const calls: { method: string; url: URL; init: RequestInit }[] = []
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(input)
    const method = init.method ?? 'GET'
    calls.push({ method, url, init })
    const route = routes[`${method} ${url.pathname}`] ?? routes[url.pathname]
    if (!route) return jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404)
    return route(url, init)
  }
  return { fetch: fetchImpl, calls }
}

export function site(overrides: Partial<Site> = {}): Site {
  return {
    name: 'my-app',
    url: 'https://my-app.sites.example.test/',
    visibility: 'private',
    spa: false,
    archived: false,
    currentVersionId: 'abcdef0123456789',
    shareUrl: null,
    restricted: false,
    audienceSize: 0,
    audienceGroups: 0,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    ...overrides,
  }
}

export async function testContext(options: {
  store: ConfigStore
  fetch?: FetchLike
  json?: boolean
  interactive?: boolean
  confirm?: (q: string) => Promise<boolean>
  prompt?: (q: string) => Promise<string>
}) {
  const log = createMemoryLogger()
  const out = createMemoryOutput(options.json ?? false)
  const ctx: CommandContext = {
    store: options.store,
    config: await options.store.resolve(),
    json: options.json ?? false,
    log,
    out,
    fetch: options.fetch ?? (() => Promise.reject(new Error('fetch not mocked'))),
    open: async () => {},
    interactive: options.interactive ?? false,
    confirm: options.confirm ?? (async () => false),
    prompt: options.prompt ?? (async () => Promise.reject(new Error('prompt not mocked'))),
    progress: () => {},
    binName: 'fling',
  }
  return { ctx, log, out }
}

/** Await a promise expected to reject and return the error. */
export async function captureError(promise: Promise<unknown>): Promise<any> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected promise to reject')
}

/** Request headers of the i-th recorded call (empty object when absent). */
export function headersOf(calls: { init: RequestInit }[], i = 0): Record<string, string> {
  return (calls[i]?.init.headers ?? {}) as Record<string, string>
}
