/**
 * `fling paths` and `--path` on versions, files, rollback, owners and publishers, against a mocked
 * Fling with Paths; and `paths init` / `paths check`, which work offline.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PathDetail, SitePath } from '@fling/shared'
import { PATHS_TEMPLATE_NAMES } from '@fling/shared/paths-templates'
import { afterEach, describe, expect, it } from 'vitest'
import {
  runPathArchive,
  runPathDelete,
  runPaths,
  runPathsCheck,
  runPathsInit,
} from '../src/commands/paths.ts'
import { runFiles, runRoles, runRollback, runVersions } from '../src/commands/sites.ts'
import {
  captureError,
  INSTANCE,
  jsonResponse,
  loggedInStore,
  mockFetch,
  runCleanups,
  SERVER,
  tempDir,
  testContext,
} from './helpers.ts'

afterEach(runCleanups)

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

const members = (emails: string[]) => ({
  emails: emails.map(email => ({ email, known: true })),
  groups: [],
})

const sitePath = (over: Partial<SitePath> = {}): SitePath => ({
  folder: 'PAY-1',
  title: 'Plan 1',
  url: 'https://team.sites.example.test/PAY-1/',
  currentVersionId: 'v2',
  archived: false,
  owners: members([ALICE]),
  publishers: members([]),
  createdBy: ALICE,
  canPublish: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-02T10:00:00.000Z',
  ...over,
})

const version = (id: string, createdAt: string) => ({
  id,
  fileCount: 1,
  totalBytes: 10,
  publishedBy: ALICE,
  path: 'PAY-1',
  createdAt,
})

/** A Fling with Paths (unless `capabilities` says otherwise) holding team's Path PAY-1. */
async function fling(capabilities: object = { paths: true }, json = false) {
  let current = sitePath()
  const bodies: { method: string; path: string; body: unknown }[] = []
  const record = (method: string, url: URL, init: RequestInit) =>
    bodies.push({
      method,
      path: url.pathname + url.search,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    })
  const instance = { ...INSTANCE, capabilities: { ...INSTANCE.capabilities, ...capabilities } }
  const m = mockFetch({
    'GET /.well-known/fling': () => jsonResponse(instance),
    'GET /api/sites/team/paths': () =>
      jsonResponse({
        paths: [
          current,
          sitePath({ folder: 'PAY-2', title: '', canPublish: false, archived: true }),
        ],
      }),
    'GET /api/sites/team/paths/PAY-1': () =>
      jsonResponse({
        ...current,
        versions: [
          version('v2', '2026-10-02T10:00:00.000Z'),
          version('v1', '2026-10-01T10:00:00.000Z'),
        ],
      } satisfies PathDetail),
    'PATCH /api/sites/team/paths/PAY-1': (url, init) => {
      record('PATCH', url, init)
      const body = JSON.parse(String(init.body))
      if (body.archived !== undefined) current = { ...current, archived: body.archived }
      for (const which of ['owners', 'publishers'] as const) {
        if (body[which]) current = { ...current, [which]: members(body[which].emails) }
      }
      return jsonResponse(current)
    },
    'POST /api/sites/team/paths/PAY-1/current': (url, init) => {
      record('POST', url, init)
      current = { ...current, currentVersionId: JSON.parse(String(init.body)).versionId }
      return jsonResponse(current)
    },
    'DELETE /api/sites/team/paths/PAY-1': (url, init) => {
      record('DELETE', url, init)
      return new Response(null, { status: 204 })
    },
    'GET /api/sites/team/versions/v1/files': (url, init) => {
      record('GET', url, init)
      return jsonResponse({
        versionId: 'v1',
        files: [{ path: 'index.html', size: 10, contentType: 'text/html' }],
        totalBytes: 10,
        generatedIndex: false,
      })
    },
  })
  const store = await loggedInStore()
  await store.putServer(SERVER, { instance })
  return {
    ...(await testContext({ store, fetch: m.fetch, json })),
    store,
    fetch: m.fetch,
    bodies,
    calls: m.calls,
  }
}

describe('fling paths <site>', () => {
  it('lists the Paths, then the home page choice', async () => {
    const { ctx, out, log } = await fling()
    await runPaths(ctx, 'team')
    const table = out.content()
    expect(table).toMatch(/PATH\s+TITLE\s+VERSION\s+STATE\s+PUBLISH\s+UPDATED/)
    expect(table).toMatch(/\/PAY-1\/\s+Plan 1\s+v2\s+live\s+yes/)
    expect(table).toMatch(/\/PAY-2\/\s+-\s+v2\s+\S*archived\S*\s+no/)
    const hints = log.lines.join('\n')
    expect(hints).toContain('fling paths init')
    expect(hints).toMatch(/no index\.html of its own/)
    expect(hints).toMatch(/without a Paths block lists no Paths/)
  })

  it('prints the list as JSON with --json', async () => {
    const { ctx, out } = await fling({ paths: true }, true)
    await runPaths(ctx, 'team')
    const data = JSON.parse(out.content())
    expect(data.name).toBe('team')
    expect(data.paths.map((p: SitePath) => p.folder)).toEqual(['PAY-1', 'PAY-2'])
  })

  it('refuses on a Fling without Paths', async () => {
    const { ctx, calls } = await fling({ paths: false })
    expect(await captureError(runPaths(ctx, 'team'))).toMatchObject({
      message: expect.stringMatching(/has no Paths/),
    })
    expect(calls.some(c => c.url.pathname.includes('/paths'))).toBe(false)
  })
})

describe('--path on versions, files, rollback, owners and publishers', () => {
  it('versions --path lists the Path’s own versions', async () => {
    const { ctx, out } = await fling()
    await runVersions(ctx, 'team', { path: '/PAY-1/' })
    expect(out.content()).toMatch(/\*\s+v2/)
    expect(out.content()).toMatch(/\s+v1/)
  })

  it('files --path lists a Path version’s files through ?path=', async () => {
    const { ctx, out, bodies, log } = await fling()
    await runFiles(ctx, 'team', 'v1', { path: 'PAY-1' })
    expect(bodies.at(-1)?.path).toBe('/api/sites/team/versions/v1/files?path=PAY-1')
    expect(out.content()).toContain('index.html')
    expect(out.content()).toContain('(not served)')
    expect(log.lines.join('\n')).not.toMatch(/will 404/)
  })

  it('rollback --path rolls back only the Path', async () => {
    const { ctx, out, bodies, log } = await fling()
    await runRollback(ctx, 'team', 'v1', { path: 'PAY-1' })
    expect(bodies).toEqual([
      { method: 'POST', path: '/api/sites/team/paths/PAY-1/current', body: { versionId: 'v1' } },
    ])
    expect(log.lines.join('\n')).toMatch(/\/PAY-1\/ of team now serves version v1/)
    expect(out.content()).toContain('https://team.sites.example.test/PAY-1/')
  })

  it('owners and publishers --path show and change the Path’s lists', async () => {
    const { ctx, out, bodies } = await fling()
    await runRoles(ctx, 'owners', 'team', { path: 'PAY-1' })
    expect(out.content()).toContain(`/PAY-1/: Owners: ${ALICE}. Publishers: nobody.`)
    await runRoles(ctx, 'publishers', 'team', { path: 'PAY-1', add: [BOB] })
    expect(bodies).toEqual([
      {
        method: 'PATCH',
        path: '/api/sites/team/paths/PAY-1',
        body: { publishers: { emails: [BOB], groups: [] } },
      },
    ])
    expect(out.content()).toContain(`Publishers: ${BOB}.`)
  })

  it('refuses a nested folder', async () => {
    const { ctx, calls } = await fling()
    expect(await captureError(runVersions(ctx, 'team', { path: 'a/b' }))).toMatchObject({
      message: 'Invalid Path "a/b"',
    })
    expect(calls).toEqual([])
  })
})

describe('fling paths archive | unarchive | delete', () => {
  it('archives and unarchives through PATCH archived', async () => {
    const { ctx, bodies } = await fling()
    await runPathArchive(ctx, 'team', 'PAY-1')
    await runPathArchive(ctx, 'team', 'PAY-1', true)
    expect(bodies.map(b => b.body)).toEqual([{ archived: true }, { archived: false }])
  })

  it('deletes only once confirmed', async () => {
    const refused = await fling()
    expect(await captureError(runPathDelete(refused.ctx, 'team', 'PAY-1', {}))).toMatchObject({
      message: expect.stringMatching(/without confirmation/),
    })
    expect(refused.bodies).toEqual([])

    const questions: string[] = []
    const { store, fetch } = refused
    const asked = await testContext({
      store,
      fetch,
      interactive: true,
      confirm: async q => {
        questions.push(q)
        return true
      },
    })
    await runPathDelete(asked.ctx, 'team', 'PAY-1', {})
    expect(questions[0]).toMatch(/Delete \/PAY-1\/ of team/)
    expect(refused.bodies.map(b => b.method)).toEqual(['DELETE'])

    const yes = await fling()
    await runPathDelete(yes.ctx, 'team', 'PAY-1', { yes: true })
    expect(yes.bodies.map(b => b.method)).toEqual(['DELETE'])
  })
})

describe('fling paths init | check', () => {
  it.each(PATHS_TEMPLATE_NAMES)(
    'init --template %s writes a page that passes check',
    async template => {
      const dir = await tempDir()
      const { ctx, log } = await testContext({ store: await loggedInStore() })
      await runPathsInit(ctx, dir, { template, title: 'Payments' })
      const html = await readFile(join(dir, 'index.html'), 'utf8')
      expect(html).toContain('<title>Payments</title>')
      await runPathsCheck(ctx, dir)
      expect(log.lines.some(l => /has a (bare|template) Paths block/.test(l))).toBe(true)
      expect(log.lines.join('\n')).not.toMatch(/Unknown|not closed|no link/)
    }
  )

  it('init never overwrites an index.html without --force', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'index.html'), '<h1>mine</h1>')
    const { ctx } = await testContext({ store: await loggedInStore() })
    expect(await captureError(runPathsInit(ctx, dir, {}))).toMatchObject({
      message: expect.stringMatching(/already exists/),
    })
    expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe('<h1>mine</h1>')
    await runPathsInit(ctx, dir, { force: true })
    expect(await readFile(join(dir, 'index.html'), 'utf8')).toContain('fling:paths')
  })

  it('check fails on a page without a block and warns on an unknown option', async () => {
    const dir = await tempDir()
    const file = join(dir, 'index.html')
    await writeFile(file, '<h1>mine</h1>')
    const { ctx, log } = await testContext({ store: await loggedInStore() })
    expect(await captureError(runPathsCheck(ctx, file))).toMatchObject({
      message: expect.stringMatching(/has no Paths block/),
    })
    await writeFile(file, '<h1>mine</h1><!-- fling:paths sideways -->')
    await runPathsCheck(ctx, dir)
    expect(log.lines.some(l => /Unknown option "sideways"/.test(l))).toBe(true)
  })
})
