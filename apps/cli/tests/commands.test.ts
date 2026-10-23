import { afterEach, describe, expect, it } from 'vitest'
import { CliApiError, createApiClient, exitCodeForStatus } from '../src/api.ts'
import { runWhoami } from '../src/commands/auth.ts'
import {
  runArchive,
  runFiles,
  runInfo,
  runList,
  runRemove,
  runShare,
  runVersions,
  runVisibility,
} from '../src/commands/sites.ts'
import { CliError, exitCodeFor, NotLoggedInError } from '../src/errors.ts'
import { discoverSitesBase, sitesBaseFor, sitesBaseFromSiteUrl, siteUrlFor } from '../src/sites.ts'
import {
  captureError,
  jsonResponse,
  loggedInStore,
  mockFetch,
  runCleanups,
  site,
  TEST_KEY,
  testContext,
} from './helpers.ts'

afterEach(runCleanups)

describe('exit codes', () => {
  it('maps errors and statuses', () => {
    expect(exitCodeForStatus(401)).toBe(2)
    expect(exitCodeForStatus(403)).toBe(3)
    expect(exitCodeForStatus(404)).toBe(1)
    expect(exitCodeForStatus(0)).toBe(1)
    expect(exitCodeFor(new NotLoggedInError('fling'))).toBe(2)
    expect(exitCodeFor(new CliApiError({ status: 403, message: 'no' }))).toBe(3)
    expect(exitCodeFor(new CliError('x'))).toBe(1)
    expect(exitCodeFor(new Error('boom'))).toBe(1)
  })

  it('turns the error envelope into a CliApiError and network failures into status 0', async () => {
    const store = await loggedInStore()
    const forbidden = mockFetch({
      '/api/sites': () => jsonResponse({ error: { code: 'forbidden', message: 'Nope' } }, 403),
    })
    const { ctx } = await testContext({ store, fetch: forbidden.fetch })
    expect(await captureError(runList(ctx, {}))).toMatchObject({
      exitCode: 3,
      code: 'forbidden',
      message: 'Nope',
    })

    const offline = await testContext({
      store,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    })
    expect(await captureError(runList(offline.ctx, {}))).toMatchObject({ exitCode: 1, status: 0 })
  })
})

describe('commands', () => {
  it('whoami prints the user and a redacted key', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      '/api/me': () =>
        jsonResponse({ email: 'a@nearform.com', name: 'A', picture: null, userSlug: 'a' }),
    })
    const { ctx, out } = await testContext({ store, fetch: m.fetch, json: true })
    await runWhoami(ctx)
    const json = JSON.parse(out.content())
    expect(json).toMatchObject({ email: 'a@nearform.com', userSlug: 'a', apiKeySource: 'config' })
    expect(out.content()).not.toContain(TEST_KEY)
  })

  it('whoami (human) shows the site URL shape without the user in it', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      '/api/me': () =>
        jsonResponse({ email: 'a@nearform.com', name: 'A', picture: null, userSlug: 'a' }),
    })
    const { ctx, out } = await testContext({ store, fetch: m.fetch })
    await runWhoami(ctx)
    expect(out.content()).toMatch(/Sites:\s+http:\/\/<name>\.server\.test\//)
    expect(out.content()).not.toMatch(/--a\b/)
  })

  it('ls passes ?archived=1 and renders a table', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      '/api/sites': () => jsonResponse({ sites: [site({ shareUrl: 'https://s-x.test/' })] }),
    })
    const { ctx, out } = await testContext({ store, fetch: m.fetch })
    await runList(ctx, { archived: true })
    expect(m.calls[0]?.url.searchParams.get('archived')).toBe('1')
    expect(out.content()).toMatch(/NAME\s+URL\s+VISIBILITY\s+SHARE\s+UPDATED/)
    expect(out.content()).toContain('https://s-x.test/')
  })

  it('versions marks the live version', async () => {
    const store = await loggedInStore()
    const detail = {
      ...site(),
      versions: [
        { id: 'abcdef0123456789', fileCount: 2, totalBytes: 2048, createdAt: site().createdAt },
      ],
    }
    const m = mockFetch({ '/api/sites/my-app': () => jsonResponse(detail) })
    const { ctx, out } = await testContext({ store, fetch: m.fetch })
    await runVersions(ctx, 'my-app')
    expect(out.content()).toMatch(/\*\s+abcdef0123456789\s+2\s+2\.0 KB/)
  })

  it("info shows the live version's file count and size", async () => {
    const store = await loggedInStore()
    const detail = {
      ...site(),
      versions: [
        { id: 'abcdef0123456789', fileCount: 3, totalBytes: 2048, createdAt: site().createdAt },
      ],
    }
    const m = mockFetch({ '/api/sites/my-app': () => jsonResponse(detail) })
    const { ctx, out } = await testContext({ store, fetch: m.fetch })
    await runInfo(ctx, 'my-app')
    expect(out.content()).toMatch(/Files:\s+3 files, 2\.0 KB/)
  })

  it('files lists the live version (or a given one) as a table or JSON', async () => {
    const store = await loggedInStore()
    const filesBody = (versionId: string, paths: string[]) => ({
      versionId,
      files: paths.map(path => ({ path, size: 1024, contentType: 'text/html' })),
      totalBytes: 1024 * paths.length,
      generatedIndex: false,
    })
    const m = mockFetch({
      'GET /api/sites/my-app': () => jsonResponse({ ...site(), versions: [] }),
      'GET /api/sites/my-app/versions/abcdef0123456789/files': () =>
        jsonResponse(filesBody('abcdef0123456789', ['docs/a.html', 'index.html'])),
      'GET /api/sites/my-app/versions/0000000000000000/files': () =>
        jsonResponse(filesBody('0000000000000000', ['page.html'])),
    })
    const a = await testContext({ store, fetch: m.fetch })
    await runFiles(a.ctx, 'my-app')
    expect(a.out.content()).toMatch(/abcdef0123456789 \(current\) — 2 files, 2\.0 KB/)
    expect(a.out.content()).toMatch(/PATH\s+SIZE\s+TYPE/)
    expect(a.out.content()).toMatch(/docs\/a\.html\s+1\.0 KB\s+text\/html/)

    const b = await testContext({ store, fetch: m.fetch, json: true })
    await runFiles(b.ctx, 'my-app', '0000000000000000')
    expect(JSON.parse(b.out.content())).toMatchObject({
      name: 'my-app',
      current: false,
      versionId: '0000000000000000',
      files: [{ path: 'page.html' }],
    })

    const never = mockFetch({
      'GET /api/sites/my-app': () =>
        jsonResponse({ ...site({ currentVersionId: null }), versions: [] }),
    })
    const c = await testContext({ store, fetch: never.fetch })
    expect(await captureError(runFiles(c.ctx, 'my-app'))).toMatchObject({
      message: expect.stringMatching(/no published version/),
    })
  })

  it('share: returns an existing link without POSTing; --refresh POSTs; --revoke DELETEs', async () => {
    const store = await loggedInStore()
    const existing = mockFetch({
      'GET /api/sites/my-app': () =>
        jsonResponse({ ...site({ shareUrl: 'https://s-old.test/' }), versions: [] }),
    })
    const a = await testContext({ store, fetch: existing.fetch })
    await runShare(a.ctx, 'my-app', {})
    expect(a.out.content().trim()).toBe('https://s-old.test/')
    expect(existing.calls.map(c => c.method)).toEqual(['GET'])

    const created = mockFetch({
      'GET /api/sites/my-app': () => jsonResponse({ ...site(), versions: [] }),
      'POST /api/sites/my-app/share': () => jsonResponse({ shareUrl: 'https://s-new.test/' }),
    })
    const b = await testContext({ store, fetch: created.fetch, json: true })
    await runShare(b.ctx, 'my-app', {})
    expect(JSON.parse(b.out.content())).toEqual({
      name: 'my-app',
      action: 'created',
      shareUrl: 'https://s-new.test/',
      ready: true,
    })

    const rotated = mockFetch({
      'POST /api/sites/my-app/share': () => jsonResponse({ shareUrl: 'https://s-rot.test/' }),
    })
    const c = await testContext({ store, fetch: rotated.fetch })
    await runShare(c.ctx, 'my-app', { refresh: true })
    expect(rotated.calls.map(x => x.method)).toEqual(['POST'])
    expect(c.out.content().trim()).toBe('https://s-rot.test/')

    const revoked = mockFetch({
      'DELETE /api/sites/my-app/share': () => new Response(null, { status: 204 }),
    })
    const d = await testContext({ store, fetch: revoked.fetch })
    await runShare(d.ctx, 'my-app', { revoke: true })
    expect(revoked.calls.map(x => x.method)).toEqual(['DELETE'])
  })

  it('visibility PATCHes and validates its argument; archive reads the site back when the body is not a site', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      'PATCH /api/sites/my-app': () => jsonResponse(site({ visibility: 'public' })),
      'POST /api/sites/my-app/archive': () => jsonResponse({ ok: true }),
      'GET /api/sites/my-app': () => jsonResponse({ ...site({ archived: true }), versions: [] }),
    })
    const { ctx } = await testContext({ store, fetch: m.fetch })
    await runVisibility(ctx, 'my-app', 'public')
    expect(JSON.parse(String(m.calls[0]?.init.body))).toEqual({ visibility: 'public' })
    expect((await captureError(runVisibility(ctx, 'my-app', 'secret'))).message).toMatch(
      /private.*public/
    )
    await runArchive(ctx, 'my-app')
    expect(m.calls.map(c => `${c.method} ${c.url.pathname}`).slice(-2)).toEqual([
      'POST /api/sites/my-app/archive',
      'GET /api/sites/my-app',
    ])
  })

  it('rm refuses without --yes off a TTY, asks on a TTY, and deletes with --yes', async () => {
    const store = await loggedInStore()
    const m = mockFetch({ 'DELETE /api/sites/my-app': () => new Response(null, { status: 204 }) })
    const nonTty = await testContext({ store, fetch: m.fetch })
    expect((await captureError(runRemove(nonTty.ctx, 'my-app', {}))).message).toMatch(
      /without confirmation/
    )

    const questions: string[] = []
    const declined = await testContext({
      store,
      fetch: m.fetch,
      interactive: true,
      confirm: async q => {
        questions.push(q)
        return false
      },
    })
    expect((await captureError(runRemove(declined.ctx, 'my-app', {}))).message).toBe('Cancelled')
    expect(questions[0]).toMatch(/Delete my-app/)
    expect(m.calls).toHaveLength(0)

    const yes = await testContext({ store, fetch: m.fetch })
    await runRemove(yes.ctx, 'my-app', { yes: true })
    expect(m.calls.map(c => c.method)).toEqual(['DELETE'])
  })
})

describe('sites base (for showing URLs before a deploy)', () => {
  it('is inferred from a production-style server URL, else read off an existing site', async () => {
    expect(sitesBaseFor('https://fling.labs.nearform.com')).toEqual({
      protocol: 'https:',
      domain: 'fling.labs.nearform.com',
    })
    expect(sitesBaseFor('http://fling.lvh.me:4100')).toBeNull()
    expect(sitesBaseFor('http://localhost')).toBeNull()
    expect(sitesBaseFromSiteUrl('http://docs.fling.lvh.me:4102/')).toEqual({
      protocol: 'http:',
      domain: 'fling.lvh.me:4102',
    })

    const m = mockFetch({
      '/api/sites': () =>
        jsonResponse({ sites: [site({ url: 'http://docs.fling.lvh.me:4102/' })] }),
    })
    const client = createApiClient({ serverUrl: 'http://fling.lvh.me:4100', fetch: m.fetch })
    const base = await discoverSitesBase(client)
    expect(base && siteUrlFor('rocketpod-docs', base)).toBe(
      'http://rocketpod-docs.fling.lvh.me:4102/'
    )
    const none = createApiClient({
      serverUrl: 'http://localhost:4100',
      fetch: mockFetch({ '/api/sites': () => jsonResponse({ sites: [] }) }).fetch,
    })
    expect(await discoverSitesBase(none)).toBeNull()
  })
})
