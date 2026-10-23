import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiClient } from '../src/api.ts'
import { runDeploy } from '../src/commands/deploy.ts'
import { defaultSiteName, deploy, NameTakenError, resolveSiteName } from '../src/deploy.ts'
import {
  captureError,
  headersOf,
  jsonResponse,
  loggedInStore,
  mockFetch,
  runCleanups,
  SERVER,
  site,
  TEST_KEY,
  tempDir,
  tempStore,
  testContext,
  writeTree,
} from './helpers.ts'

afterEach(runCleanups)

const VERSION = '0123456789abcdef'
const noSleep = async () => {}

async function folder() {
  const root = await tempDir()
  const dir = join(root, 'my-app')
  await writeTree(dir, { 'index.html': '<h1>hi</h1>', 'assets/app.js': 'x()' })
  return dir
}

function deps(fetchImpl: ReturnType<typeof mockFetch>['fetch']) {
  return {
    client: createApiClient({ serverUrl: SERVER, apiKey: TEST_KEY, fetch: fetchImpl }),
    fetch: fetchImpl,
    sleep: noSleep,
  }
}

describe('site names', () => {
  it('defaults to the slugified folder name, or its parent for build dirs', () => {
    expect(defaultSiteName('/x/My Cool App')).toBe('my-cool-app')
    expect(defaultSiteName('/x/hello-world/dist')).toBe('hello-world')
    expect(defaultSiteName('/x/proj/build')).toBe('proj')
  })
  it('validates explicit names', async () => {
    expect(resolveSiteName('/x/a', 'ok-name')).toBe('ok-name')
    expect(() => resolveSiteName('/x/a', 'Bad Name')).toThrow(/Invalid site name/)
    expect(() => resolveSiteName('/x/a', 'a--b')).toThrow(/Invalid site name/)
  })
})

describe('deploy flow', () => {
  it('unchanged: one POST, no uploads', async () => {
    const dir = await folder()
    const m = mockFetch({
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({ status: 'unchanged', versionId: VERSION, site: site() }),
    })
    const r = await deploy(deps(m.fetch), { dir })
    expect(r).toMatchObject({
      status: 'unchanged',
      name: 'my-app',
      uploaded: 0,
      fileCount: 2,
      url: site().url,
    })
    expect(m.calls).toHaveLength(1)
    const body = JSON.parse(String(m.calls[0]?.init.body))
    expect(body.manifest.files).toHaveLength(2)
    expect(body.manifest.files[1]).toEqual({
      path: 'index.html',
      sha256: createHash('sha256').update('<h1>hi</h1>').digest('hex'),
      size: 11,
      contentType: 'text/html; charset=utf-8',
    })
    expect(body).not.toHaveProperty('spa')
    expect(body).not.toHaveProperty('visibility')
    expect(headersOf(m.calls).Authorization).toBe(`Bearer ${TEST_KEY}`)
  })

  it('repointed: reports the restored version', async () => {
    const dir = await folder()
    const m = mockFetch({
      'POST /api/sites/other/deploys': () =>
        jsonResponse({ status: 'repointed', versionId: VERSION, site: site({ name: 'other' }) }),
    })
    const r = await deploy(deps(m.fetch), { dir, name: 'other', spa: true, public: true })
    expect(r.status).toBe('repointed')
    expect(JSON.parse(String(m.calls[0]?.init.body))).toMatchObject({
      spa: true,
      visibility: 'public',
    })
  })

  it('upload: PUTs the requested files with the signed headers (no bearer), then finalizes', async () => {
    const dir = await folder()
    const puts: { url: string; headers: Record<string, string>; body: string }[] = []
    const m = mockFetch({
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({
          status: 'upload',
          versionId: VERSION,
          uploads: [
            {
              path: 'index.html',
              url: 'https://s3.test/put/index',
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
            },
            {
              path: 'assets/app.js',
              url: 'https://s3.test/put/app',
              headers: { 'Content-Type': 'text/javascript' },
            },
          ],
        }),
      'PUT /put/index': (url, init) => {
        puts.push({
          url: url.toString(),
          headers: init.headers as Record<string, string>,
          body: Buffer.from(init.body as Uint8Array).toString(),
        })
        return new Response(null, { status: 200 })
      },
      'PUT /put/app': (url, init) => {
        puts.push({
          url: url.toString(),
          headers: init.headers as Record<string, string>,
          body: Buffer.from(init.body as Uint8Array).toString(),
        })
        return new Response(null, { status: 200 })
      },
      [`POST /api/sites/my-app/deploys/${VERSION}/finalize`]: () =>
        jsonResponse({ status: 'live', versionId: VERSION, site: site() }),
    })
    const progress: number[] = []
    const r = await deploy(deps(m.fetch), { dir, onProgress: p => progress.push(p.uploaded) })
    expect(r).toMatchObject({ status: 'live', uploaded: 2, versionId: VERSION })
    expect(puts.map(p => p.body).sort()).toEqual(['<h1>hi</h1>', 'x()'])
    expect(puts.find(p => p.url.endsWith('index'))?.headers).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
    })
    expect(m.calls.at(-1)?.url.pathname).toBe(`/api/sites/my-app/deploys/${VERSION}/finalize`)
    expect(progress).toEqual([0, 1, 2])
  })

  it('retries a failed PUT (5xx / network) and then succeeds', async () => {
    const dir = await folder()
    let attempts = 0
    const m = mockFetch({
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({
          status: 'upload',
          versionId: VERSION,
          uploads: [{ path: 'index.html', url: 'https://s3.test/put/i', headers: {} }],
        }),
      'PUT /put/i': () => {
        attempts++
        if (attempts === 1) throw new TypeError('fetch failed')
        if (attempts === 2) return new Response('slow down', { status: 503 })
        return new Response(null, { status: 200 })
      },
      [`POST /api/sites/my-app/deploys/${VERSION}/finalize`]: () =>
        jsonResponse({ status: 'live', versionId: VERSION, site: site() }),
    })
    const r = await deploy(deps(m.fetch), { dir })
    expect(attempts).toBe(3)
    expect(r.status).toBe('live')
  })

  it('gives up after 3 retries and does not finalize; 4xx is not retried', async () => {
    const dir = await folder()
    let attempts = 0
    const m = mockFetch({
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({
          status: 'upload',
          versionId: VERSION,
          uploads: [{ path: 'index.html', url: 'https://s3.test/put/i', headers: {} }],
        }),
      'PUT /put/i': () => {
        attempts++
        return new Response(null, { status: 500 })
      },
    })
    const e = await captureError(deploy(deps(m.fetch), { dir }))
    expect(e.message).toMatch(/Upload of index\.html failed: HTTP 500/)
    expect(attempts).toBe(4)
    expect(m.calls.some(c => c.url.pathname.endsWith('/finalize'))).toBe(false)

    attempts = 0
    const m2 = mockFetch({
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({
          status: 'upload',
          versionId: VERSION,
          uploads: [{ path: 'index.html', url: 'https://s3.test/put/i', headers: {} }],
        }),
      'PUT /put/i': () => {
        attempts++
        return new Response(null, { status: 403 })
      },
    })
    expect((await captureError(deploy(deps(m2.fetch), { dir }))).message).toMatch(/HTTP 403/)
    expect(attempts).toBe(1)
  })

  it('maps API errors to exit codes', async () => {
    const dir = await folder()
    const unauth = mockFetch({
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({ error: { code: 'unauthorized', message: 'Bad key' } }, 401),
    })
    const e = await captureError(deploy(deps(unauth.fetch), { dir }))
    expect(e).toMatchObject({ exitCode: 2, message: 'Bad key', code: 'unauthorized' })
  })
})

describe('fling [dir] command', () => {
  it('waits for the edge after a deploy goes live, and warns when it times out', async () => {
    const dir = await folder()
    const m = mockFetch({
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({ status: 'repointed', versionId: VERSION, site: site() }),
    })
    const store = await loggedInStore()
    const { ctx, out, log } = await testContext({ store, fetch: m.fetch, json: true })
    const waited: string[] = []
    ctx.waitReady = async url => {
      waited.push(url)
      return { ready: false, waitedMs: 15_000 }
    }
    await runDeploy(ctx, dir, {})
    expect(waited).toEqual([site().url])
    expect(JSON.parse(out.content())).toMatchObject({ status: 'repointed', ready: false })
    expect(log.lines.join('\n')).toMatch(/reload if you see a 404/)

    // unchanged: already live, no wait
    const same = mockFetch({
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({ status: 'unchanged', versionId: VERSION, site: site() }),
    })
    const b = await testContext({ store, fetch: same.fetch })
    b.ctx.waitReady = async url => {
      waited.push(url)
      return { ready: true, waitedMs: 0 }
    }
    await runDeploy(b.ctx, dir, {})
    expect(waited).toHaveLength(1)
  })

  it('prints the URL, and the site + status under --json', async () => {
    const dir = await folder()
    const m = mockFetch({
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({ status: 'unchanged', versionId: VERSION, site: site() }),
    })
    const store = await loggedInStore()
    const human = await testContext({ store, fetch: m.fetch })
    await runDeploy(human.ctx, dir, {})
    expect(human.out.content()).toContain(site().url)
    expect(human.log.lines.join('\n')).toMatch(/Unchanged/)

    const json = await testContext({ store, fetch: m.fetch, json: true })
    await runDeploy(json.ctx, dir, {})
    expect(JSON.parse(json.out.content())).toEqual({
      status: 'unchanged',
      site: site(),
      ready: true,
      skipped: { dotfiles: [], gitignored: [] },
    })
  })

  it('a path that does not exist is an error: the CLI never looks in Downloads', async () => {
    const { ctx } = await testContext({ store: await loggedInStore() })
    const e = await captureError(runDeploy(ctx, 'No Such Deck.html', {}))
    expect(e.message).toBe('No such file or folder: No Such Deck.html')
    expect(e.exitCode).toBe(1)
  })

  it('exits 2 when not logged in', async () => {
    const { store } = await tempStore()
    const { ctx } = await testContext({ store })
    const e = await captureError(runDeploy(ctx, '.', {}))
    expect(e.exitCode).toBe(2)
  })
})

describe('name and index.html prompts', () => {
  const names =
    (status: string, suggestions: string[] = []) =>
    (url: URL) =>
      jsonResponse({
        name: decodeURIComponent(url.pathname.split('/').at(-1) ?? ''),
        status,
        suggestions,
      })
  const unchanged = (name: string) => () =>
    jsonResponse({ status: 'unchanged', versionId: VERSION, site: site({ name }) })
  const taken409 = (suggestions?: string[]) => () =>
    jsonResponse(
      {
        error: {
          code: 'name_taken',
          message: 'Name taken',
          ...(suggestions ? { suggestions } : {}),
        },
      },
      409
    )
  /** A prompt that answers from a script and records the questions. */
  function script(...answers: string[]) {
    const questions: string[] = []
    return {
      questions,
      prompt: async (q: string) => {
        questions.push(q)
        const a = answers.shift()
        if (a === undefined) throw new Error(`unexpected prompt: ${q}`)
        return a
      },
    }
  }
  const deployed = (m: ReturnType<typeof mockFetch>) =>
    m.calls.filter(c => c.method === 'POST').map(c => c.url.pathname)

  it('Enter accepts the generated name, showing its URL and that it is new', async () => {
    const dir = await folder()
    const m = mockFetch({
      'GET /api/names/my-app': names('available'),
      'POST /api/sites/my-app/deploys': unchanged('my-app'),
    })
    const p = script('')
    const { ctx, log } = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      interactive: true,
      prompt: p.prompt,
    })
    await runDeploy(ctx, dir, {})
    expect(p.questions).toEqual(['Use "my-app"? [Y/n or type another name] '])
    expect(log.lines.join('\n')).toMatch(
      /Site name: .*my-app.* → http:\/\/my-app\.server\.test\/ .*\(new\)/
    )
    expect(deployed(m)).toEqual(['/api/sites/my-app/deploys'])
  })

  it('typing a name validates it and re-checks it; "yours" says it updates the site', async () => {
    const dir = await folder()
    const m = mockFetch({
      'GET /api/names/my-app': names('available'),
      'GET /api/names/other': names('yours'),
      'POST /api/sites/other/deploys': unchanged('other'),
    })
    const p = script('Bad Name', 'other', 'y')
    const { ctx, log } = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      interactive: true,
      prompt: p.prompt,
    })
    await runDeploy(ctx, dir, {})
    expect(p.questions).toEqual([
      'Use "my-app"? [Y/n or type another name] ',
      'Use "my-app"? [Y/n or type another name] ',
      'Use "other"? [Y/n or type another name] ',
    ])
    const text = log.lines.join('\n')
    expect(text).toMatch(/"Bad Name" is not a valid site name/)
    expect(text).toMatch(/other.*\(updates your existing site\)/)
    expect(deployed(m)).toEqual(['/api/sites/other/deploys'])
  })

  it('a taken name lists suggestions and defaults to the first', async () => {
    const dir = await folder()
    const m = mockFetch({
      'GET /api/names/my-app': names('taken', ['my-app-cc', 'my-app-cc2']),
      'POST /api/sites/my-app-cc/deploys': unchanged('my-app-cc'),
    })
    const p = script('')
    const { ctx, log } = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      interactive: true,
      prompt: p.prompt,
    })
    await runDeploy(ctx, dir, {})
    expect(log.lines.join('\n')).toMatch(/my-app is taken\. Suggestions: my-app-cc, my-app-cc2/)
    expect(p.questions).toEqual(['Use "my-app-cc"? [Y/n or type another name] '])
    expect(deployed(m)).toEqual(['/api/sites/my-app-cc/deploys'])
  })

  it('"n" aborts with exit 1 and deploys nothing', async () => {
    const dir = await folder()
    const m = mockFetch({ 'GET /api/names/my-app': names('available') })
    const { ctx } = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      interactive: true,
      prompt: script('n').prompt,
    })
    const e = await captureError(runDeploy(ctx, dir, {}))
    expect(e).toMatchObject({ exitCode: 1, message: expect.stringMatching(/Aborted/) })
    expect(deployed(m)).toEqual([])
  })

  const LIST_Q =
    'No index.html at the root. [L]ist the HTML pages on a generated index page / [f]ling anyway (the root will 404) / [a]bort '
  /** Paths in the manifest of the i-th deploy request. */
  const manifestOf = (m: ReturnType<typeof mockFetch>, i = 0) => {
    const call = m.calls.filter(c => c.method === 'POST')[i]
    return JSON.parse(String(call?.init.body)).manifest.files as { path: string; sha256: string }[]
  }
  async function pagesFolder(
    files: Record<string, string> = {
      'page.html': '<title>Page One</title>x',
      'docs/two.html': 'y',
    }
  ) {
    const root = await tempDir()
    const dir = join(root, 'my-app')
    await writeTree(dir, files)
    return dir
  }

  it('no index.html on a TTY: Enter (= L) generates a listing index in memory and deploys it', async () => {
    const dir = await pagesFolder()
    const m = mockFetch({ 'POST /api/sites/my-app/deploys': unchanged('my-app') })
    const p = script('')
    const { ctx, log } = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      interactive: true,
      prompt: p.prompt,
    })
    await runDeploy(ctx, dir, { name: 'my-app' })
    expect(p.questions).toEqual([LIST_Q])
    expect(manifestOf(m).map(f => f.path)).toEqual(['docs/two.html', 'index.html', 'page.html'])
    expect(log.lines.join('\n')).toMatch(/Generated index\.html listing 2 HTML pages/)
    // Never written to the user's folder.
    expect(existsSync(join(dir, 'index.html'))).toBe(false)
  })

  it('no index.html on a TTY: f flings anyway (warning), a aborts, junk re-asks', async () => {
    const dir = await pagesFolder()
    const m = mockFetch({ 'POST /api/sites/my-app/deploys': unchanged('my-app') })
    const abort = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      interactive: true,
      prompt: script('what', 'a').prompt,
    })
    const e = await captureError(runDeploy(abort.ctx, dir, { name: 'my-app' }))
    expect(e).toMatchObject({ exitCode: 1, message: expect.stringMatching(/no index\.html/) })
    expect(e.hint).toMatch(/--list-html/)
    expect(deployed(m)).toEqual([])

    const fling = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      interactive: true,
      prompt: script('f').prompt,
    })
    await runDeploy(fling.ctx, dir, { name: 'my-app' })
    expect(manifestOf(m).map(f => f.path)).toEqual(['docs/two.html', 'page.html'])
    expect(fling.log.lines.join('\n')).toMatch(
      /No index\.html at the root — http:\/\/my-app\.server\.test\/ will show a 404\./
    )
  })

  it('no index.html and no HTML pages: L is not offered and Enter aborts', async () => {
    const dir = await pagesFolder({ 'style.css': 'x' })
    const m = mockFetch({ 'POST /api/sites/my-app/deploys': unchanged('my-app') })
    const p = script('')
    const { ctx } = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      interactive: true,
      prompt: p.prompt,
    })
    await captureError(runDeploy(ctx, dir, { name: 'my-app' }))
    expect(p.questions[0]).toMatch(
      /^No index\.html at the root \(and no HTML pages to list\)\. \[f\]ling anyway .* \[A\]bort $/
    )
    expect(deployed(m)).toEqual([])
  })

  it('--list-html / --no-list-html decide without asking', async () => {
    const dir = await pagesFolder()
    const m = mockFetch({ 'POST /api/sites/my-app/deploys': unchanged('my-app') })
    const noPrompt = () => Promise.reject(new Error('should not prompt'))
    const a = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      interactive: true,
      prompt: noPrompt,
    })
    await runDeploy(a.ctx, dir, { name: 'my-app', listHtml: true })
    const b = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      interactive: true,
      prompt: noPrompt,
    })
    await runDeploy(b.ctx, dir, { name: 'my-app', listHtml: false })
    expect(manifestOf(m, 0).some(f => f.path === 'index.html')).toBe(true)
    expect(manifestOf(m, 1).some(f => f.path === 'index.html')).toBe(false)
  })

  it('non-TTY / --yes: never prompts; lists HTML pages if any, else only warns', async () => {
    for (const interactive of [false, true]) {
      const withPages = await pagesFolder()
      const m = mockFetch({ 'POST /api/sites/my-app/deploys': unchanged('my-app') })
      const { ctx } = await testContext({
        store: await loggedInStore(),
        fetch: m.fetch,
        interactive,
        prompt: () => Promise.reject(new Error('prompt should not be called')),
      })
      await runDeploy(ctx, withPages, { yes: interactive })
      expect(manifestOf(m).some(f => f.path === 'index.html')).toBe(true)

      const noPages = await pagesFolder({ 'style.css': 'x' })
      const m2 = mockFetch({ 'POST /api/sites/my-app/deploys': unchanged('my-app') })
      const other = await testContext({
        store: await loggedInStore(),
        fetch: m2.fetch,
        interactive,
      })
      await runDeploy(other.ctx, noPages, { yes: interactive })
      const warnings = other.log.lines.filter(l => l.includes('index.html'))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/will show a 404/)
    }
  })

  it('the generated listing is byte-identical across deploys (so the second is unchanged)', async () => {
    const dir = await pagesFolder()
    const seen = new Set<string>()
    const m = mockFetch({
      'POST /api/sites/my-app/deploys': (_url, init) => {
        const key = JSON.stringify(JSON.parse(String(init.body)).manifest)
        const status = seen.has(key) ? 'unchanged' : 'repointed'
        seen.add(key)
        return jsonResponse({ status, versionId: VERSION, site: site() })
      },
    })
    const statuses: string[] = []
    for (let i = 0; i < 2; i++) {
      const { ctx, out } = await testContext({
        store: await loggedInStore(),
        fetch: m.fetch,
        json: true,
      })
      await runDeploy(ctx, dir, { name: 'my-app', listHtml: true })
      statuses.push(JSON.parse(out.content()).status)
    }
    expect(statuses).toEqual(['repointed', 'unchanged'])
  })

  it('non-TTY: a taken generated name fails with the suggestions and says to pass --name', async () => {
    const dir = await folder()
    const m = mockFetch({ 'POST /api/sites/my-app/deploys': taken409(['my-app-cc', 'my-app-cc2']) })
    const { ctx } = await testContext({ store: await loggedInStore(), fetch: m.fetch })
    const e = await captureError(runDeploy(ctx, dir, {}))
    expect(e).toBeInstanceOf(NameTakenError)
    expect(e).toMatchObject({
      exitCode: 1,
      code: 'name_taken',
      suggestions: ['my-app-cc', 'my-app-cc2'],
    })
    expect(e.message).toMatch(/"my-app" is taken.*my-app-cc, my-app-cc2/)
    expect(e.hint).toMatch(/--name my-app-cc/)
  })

  it('--name on a TTY: no prompt; a taken name (409 race or not) errors, fetching suggestions if absent', async () => {
    const dir = await folder()
    const m = mockFetch({
      'POST /api/sites/theirs/deploys': taken409(),
      'GET /api/names/theirs': names('taken', ['theirs-cc']),
    })
    const { ctx } = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      interactive: true,
    })
    const e = await captureError(runDeploy(ctx, dir, { name: 'theirs' }))
    expect(e).toMatchObject({ code: 'name_taken', suggestions: ['theirs-cc'] })
    expect(m.calls.map(c => `${c.method} ${c.url.pathname}`)).toEqual([
      'POST /api/sites/theirs/deploys',
      'GET /api/names/theirs',
    ])
  })

  it('a 409 after the prompt (someone grabbed the name meanwhile) is reported with suggestions', async () => {
    const dir = await folder()
    const m = mockFetch({
      'GET /api/names/my-app': names('available'),
      'POST /api/sites/my-app/deploys': taken409(['my-app-cc']),
    })
    const { ctx } = await testContext({
      store: await loggedInStore(),
      fetch: m.fetch,
      interactive: true,
      prompt: script('').prompt,
    })
    const e = await captureError(runDeploy(ctx, dir, {}))
    expect(e.message).toMatch(/taken.*my-app-cc/)
  })
})
