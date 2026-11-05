/**
 * `fling pull` and deploying a pulled folder: the files and the site link written, hashes checked,
 * a folder that isn't empty, a pull of one folder; then the deploy on the version pulled (the
 * complete form after a whole-site pull, the partial one after a folder's), the summary, the link
 * updated, `base_changed` stopping with what to do, and `--force`; and the local MCP's fling_pull,
 * fling_deploy of the folder, fling_read_files and fling_publish with `base`.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiClient } from '../src/api.ts'
import { runDeploy } from '../src/commands/deploy.ts'
import { runPull } from '../src/commands/pull.ts'
import { BaseChangedError } from '../src/deploy.ts'
import { createMcpServer } from '../src/mcp.ts'
import { describeChanges, onLink, pullSite, readSiteLink, SITE_LINK_FILE } from '../src/pull.ts'
import {
  captureError,
  INSTANCE,
  jsonResponse,
  loggedInStore,
  mockFetch,
  type Route,
  runCleanups,
  SERVER,
  site,
  TEST_KEY,
  tempDir,
  testContext,
  writeTree,
} from './helpers.ts'

afterEach(runCleanups)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const BASE = 'base0123456789ab'
const NEXT = 'next0123456789ab'

const remote: Record<string, string> = {
  'index.html': '<h1>v1</h1>',
  'about.html': '<h1>about</h1>',
  '30-10-26/index.html': '<h1>week</h1>',
}

/** The pull route over `remote` (or only `path`'s files), with each file served by a blob URL. */
function pullRoutes(files = remote, bodies: Record<string, string> = files): Record<string, Route> {
  return {
    'GET /.well-known/fling': () =>
      jsonResponse({ ...INSTANCE, capabilities: { ...INSTANCE.capabilities, pull: true } }),
    'GET /api/sites/my-app/pull': url => {
      const path = url.searchParams.get('path')
      const entries = Object.entries(files).filter(([p]) => !path || p.startsWith(`${path}/`))
      return jsonResponse({
        versionId: BASE,
        ...(path ? { path } : {}),
        expiresAt: '2026-11-01T00:15:00.000Z',
        files: entries.map(([p, content]) => ({
          path: p,
          size: Buffer.byteLength(content),
          contentType: 'text/html',
          sha256: sha(content),
          url: `${SERVER}/blob/${p}`,
        })),
      })
    },
    ...Object.fromEntries(
      Object.entries(bodies).map(([p, content]) => [`GET /blob/${p}`, () => new Response(content)])
    ),
  }
}

const client = (fetchImpl: ReturnType<typeof mockFetch>['fetch']) => ({
  client: createApiClient({ serverUrl: SERVER, apiKey: TEST_KEY, fetch: fetchImpl }),
  fetch: fetchImpl,
  sleep: async () => {},
})

describe('pull', () => {
  it('writes the files and a site link with each file’s hash', async () => {
    const dir = join(await tempDir(), 'my-app')
    const m = mockFetch(pullRoutes())
    const pulled = await pullSite(client(m.fetch), { name: 'my-app', dir })
    expect(pulled).toMatchObject({ versionId: BASE, fileCount: 3, server: SERVER })
    expect(await readFile(join(dir, '30-10-26/index.html'), 'utf8')).toBe('<h1>week</h1>')
    expect(await readSiteLink(dir)).toEqual({
      server: SERVER,
      name: 'my-app',
      versionId: BASE,
      files: Object.fromEntries(Object.entries(remote).map(([p, c]) => [p, sha(c)])),
    })
  })

  it('with a path, writes that folder’s files at the top', async () => {
    const dir = join(await tempDir(), 'week')
    const m = mockFetch(pullRoutes())
    await pullSite(client(m.fetch), { name: 'my-app', dir, path: '30-10-26' })
    expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe('<h1>week</h1>')
    expect(existsSync(join(dir, 'about.html'))).toBe(false)
    expect((await readSiteLink(dir))?.path).toBe('30-10-26')
  })

  it('refuses bytes that don’t match their hash, and a folder that isn’t empty without force', async () => {
    const dir = join(await tempDir(), 'my-app')
    const bad = mockFetch(pullRoutes(remote, { ...remote, 'about.html': 'tampered' }))
    const err = await captureError(pullSite(client(bad.fetch), { name: 'my-app', dir }))
    expect(err.message).toMatch(/about.html.*do not match/)

    await writeTree(dir, { 'mine.txt': 'x' })
    const m = mockFetch(pullRoutes())
    expect(
      (await captureError(pullSite(client(m.fetch), { name: 'my-app', dir }))).message
    ).toMatch(/not empty/)
    await pullSite(client(m.fetch), { name: 'my-app', dir, force: true })
    expect(existsSync(join(dir, 'mine.txt'))).toBe(true)
  })

  it('pulling over an earlier pull of the site removes what the site no longer has', async () => {
    const dir = join(await tempDir(), 'my-app')
    await pullSite(client(mockFetch(pullRoutes()).fetch), { name: 'my-app', dir })
    const { 'about.html': _gone, ...now } = remote
    await pullSite(client(mockFetch(pullRoutes(now)).fetch), { name: 'my-app', dir, force: true })
    expect(existsSync(join(dir, 'about.html'))).toBe(false)
    expect(existsSync(join(dir, 'index.html'))).toBe(true)
  })

  it('`fling pull` defaults to ./<name> and says how to deploy', async () => {
    const store = await loggedInStore()
    const m = mockFetch(pullRoutes())
    const { ctx, log } = await testContext({ store, fetch: m.fetch })
    const cwd = process.cwd()
    process.chdir(await tempDir())
    try {
      await runPull(ctx, 'my-app', undefined, {})
      expect(existsSync(join(process.cwd(), 'my-app', SITE_LINK_FILE))).toBe(true)
    } finally {
      process.chdir(cwd)
    }
    expect(log.lines.join('\n')).toMatch(/Pulled my-app into my-app .*3 files/)
  })
})

describe('changes against the pull', () => {
  const link = {
    server: SERVER,
    name: 'my-app',
    versionId: BASE,
    files: { 'index.html': sha('a'), 'about.html': sha('b'), 'old.html': sha('c') },
  }
  const local = (files: Record<string, string>) => ({
    files: Object.entries(files).map(([path, c]) => ({ path, sha256: sha(c) })),
  })

  it('a whole-site pull deploys the whole folder on its base', () => {
    const plan = onLink(link, local({ 'index.html': 'A', 'about.html': 'b', 'new.html': 'n' }))
    expect(plan).toEqual({
      base: BASE,
      changes: { changed: ['index.html'], added: ['new.html'], removed: ['old.html'] },
    })
    expect(describeChanges(plan.changes)).toBe('1 changed, 1 added, 1 removed')
  })

  it('a Path’s pull deploys the whole folder to that Path, on the version pulled', () => {
    const plan = onLink(
      { ...link, path: 'w', files: { 'w/index.html': sha('a'), 'w/x.html': sha('x') } },
      local({ 'index.html': 'a' })
    )
    expect(plan).toEqual({ base: BASE, path: 'w', changes: expect.anything() })
    expect(describeChanges(plan.changes)).toBe('1 removed')
  })
})

describe('deploying a pulled folder', () => {
  /** A pulled folder, edited: index.html changed, about.html deleted, new.html added. */
  async function edited() {
    const dir = join(await tempDir(), 'my-app')
    await pullSite(client(mockFetch(pullRoutes()).fetch), { name: 'my-app', dir })
    await writeTree(dir, { 'index.html': '<h1>v2</h1>', 'new.html': '<h1>new</h1>' })
    const { rm } = await import('node:fs/promises')
    await rm(join(dir, 'about.html'))
    return dir
  }

  function deployRoutes(answer: 'live' | 'base_changed') {
    return mockFetch({
      ...pullRoutes(),
      'POST /api/sites/my-app/deploys': (_url, init) => {
        const body = JSON.parse(String(init.body))
        if (answer === 'base_changed')
          return jsonResponse({ error: { code: 'base_changed', message: 'moved' } }, 409)
        return jsonResponse({
          status: 'upload',
          versionId: NEXT,
          uploads: body.manifest.files
            .filter((f: { path: string }) => f.path !== '30-10-26/index.html')
            .map((f: { path: string }) => ({
              path: f.path,
              url: `${SERVER}/up/${f.path}`,
              headers: {},
            })),
        })
      },
      'PUT /up/index.html': () => new Response(null),
      'PUT /up/new.html': () => new Response(null),
      [`POST /api/sites/my-app/deploys/${NEXT}/finalize`]: () =>
        jsonResponse({ status: 'live', versionId: NEXT, site: site() }),
    })
  }

  it('publishes on the version pulled, says what changed and updates the link', async () => {
    const dir = await edited()
    const m = deployRoutes('live')
    const { ctx, log } = await testContext({ store: await loggedInStore(), fetch: m.fetch })
    await runDeploy(ctx, dir, {})
    const post = m.calls.find(c => c.method === 'POST' && c.url.pathname.endsWith('/deploys'))
    const body = JSON.parse(String(post?.init.body))
    expect(body.base).toBe(BASE)
    expect(body.partial).toBeUndefined()
    expect(body.manifest.files.map((f: { path: string }) => f.path).sort()).toEqual([
      '30-10-26/index.html',
      'index.html',
      'new.html',
    ])
    expect(log.lines.join('\n')).toMatch(/1 changed, 1 added, 1 removed since base0123456789ab/)
    const link = await readSiteLink(dir)
    expect(link?.versionId).toBe(NEXT)
    expect(Object.keys(link?.files ?? {}).sort()).toEqual([
      '30-10-26/index.html',
      'index.html',
      'new.html',
    ])
  })

  it('stops on base_changed, once, saying what to do; --force publishes without a base', async () => {
    const dir = await edited()
    const stale = deployRoutes('base_changed')
    const { ctx } = await testContext({ store: await loggedInStore(), fetch: stale.fetch })
    const err = await captureError(runDeploy(ctx, dir, {}))
    expect(err).toBeInstanceOf(BaseChangedError)
    expect(err.message).toMatch(/changed since you pulled it/)
    expect(err.hint).toMatch(/fling pull my-app .*--force/)
    expect(stale.calls.filter(c => c.method === 'POST')).toHaveLength(1)
    expect((await readSiteLink(dir))?.versionId).toBe(BASE)

    const m = deployRoutes('live')
    const forced = await testContext({ store: await loggedInStore(), fetch: m.fetch })
    await runDeploy(forced.ctx, dir, { force: true })
    const post = m.calls.find(c => c.method === 'POST' && c.url.pathname.endsWith('/deploys'))
    expect(JSON.parse(String(post?.init.body)).base).toBeUndefined()
    expect((await readSiteLink(dir))?.versionId).toBe(NEXT)
  })

  it('after a Path’s pull, publishes the folder to that Path on the version pulled', async () => {
    const dir = join(await tempDir(), 'week')
    await pullSite(client(mockFetch(pullRoutes()).fetch), {
      name: 'my-app',
      dir,
      path: '30-10-26',
    })
    await writeTree(dir, { 'index.html': '<h1>new week</h1>' })
    const m = mockFetch({
      ...pullRoutes(),
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({ status: 'unchanged', versionId: NEXT, site: site() }),
    })
    const { ctx } = await testContext({ store: await loggedInStore(), fetch: m.fetch })
    await runDeploy(ctx, dir, {})
    const post = m.calls.find(c => c.method === 'POST')
    const body = JSON.parse(String(post?.init.body))
    expect(body).toMatchObject({ base: BASE, path: '30-10-26' })
    expect(body.partial).toBeUndefined()
    expect(body.manifest.files.map((f: { path: string }) => f.path)).toEqual([
      '30-10-26/index.html',
    ])
  })

  it('deploys as a plain folder to another site named with --name', async () => {
    const dir = await edited()
    const m = mockFetch({
      ...pullRoutes(),
      'POST /api/sites/other/deploys': () =>
        jsonResponse({ status: 'unchanged', versionId: NEXT, site: site({ name: 'other' }) }),
    })
    const { ctx, log } = await testContext({ store: await loggedInStore(), fetch: m.fetch })
    await runDeploy(ctx, dir, { name: 'other' })
    const body = JSON.parse(String(m.calls.find(c => c.method === 'POST')?.init.body))
    expect(body.base).toBeUndefined()
    expect(log.lines.join('\n')).toMatch(/pulled from my-app/)
  })
})

describe('the local MCP tools', () => {
  async function connect(fetchImpl: ReturnType<typeof mockFetch>['fetch'], home: string) {
    const server = createMcpServer({
      store: await loggedInStore(),
      fetch: fetchImpl,
      locate: { cwd: home, home, platform: process.platform, env: {} },
      waitReady: async () => ({ ready: true, waitedMs: 0 }),
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const mcp = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([server.connect(serverT), mcp.connect(clientT)])
    return mcp
  }
  const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? ''
  const dataOf = (r: unknown) => JSON.parse(textOf(r).slice(textOf(r).indexOf('\n\n') + 2))

  it('fling_pull writes ~/Documents/Claude/fling/<name>; fling_deploy publishes it on its base', async () => {
    const home = await tempDir()
    const m = mockFetch({
      ...pullRoutes(),
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({ error: { code: 'base_changed', message: 'moved' } }, 409),
    })
    const mcp = await connect(m.fetch, home)
    const pulled = await mcp.callTool({ name: 'fling_pull', arguments: { name: 'my-app' } })
    expect(pulled.isError).toBeFalsy()
    const dir = join(home, 'Documents', 'Claude', 'fling', 'my-app')
    expect(dataOf(pulled).dir).toBe(dir)
    expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe('<h1>v1</h1>')

    await writeTree(dir, { 'index.html': '<h1>v2</h1>' })
    const res = await mcp.callTool({ name: 'fling_deploy', arguments: { path: dir } })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/changed since you pulled it.*fling_pull/)
    const body = JSON.parse(String(m.calls.find(c => c.method === 'POST')?.init.body))
    expect(body.base).toBe(BASE)
  })

  it('fling_read_files returns contents and the base; fling_publish sends base and remove', async () => {
    const home = await tempDir()
    const m = mockFetch({
      ...pullRoutes(),
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({ status: 'unchanged', versionId: BASE, site: site() }),
    })
    const mcp = await connect(m.fetch, home)
    const read = await mcp.callTool({
      name: 'fling_read_files',
      arguments: { name: 'my-app', paths: ['index.html'] },
    })
    expect(read.isError).toBeFalsy()
    expect(dataOf(read)).toMatchObject({
      versionId: BASE,
      files: [{ path: 'index.html', encoding: 'utf8', content: '<h1>v1</h1>' }],
    })
    const pub = await mcp.callTool({
      name: 'fling_publish',
      arguments: {
        name: 'my-app',
        base: BASE,
        files: [{ path: 'index.html', content: '<h1>v2</h1>' }],
        remove: ['about.html'],
      },
    })
    expect(pub.isError).toBeFalsy()
    const body = JSON.parse(String(m.calls.find(c => c.method === 'POST')?.init.body))
    expect(body).toMatchObject({ base: BASE, partial: true, remove: ['about.html'] })
    expect(body.manifest.files.map((f: { path: string }) => f.path)).toEqual(['index.html'])
  })
})
