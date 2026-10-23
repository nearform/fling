import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { mcpTools } from '@fling/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/api.ts'
import type { ConfigStore } from '../src/config.ts'
import { createMcpServer, type McpDeps } from '../src/mcp.ts'
import {
  jsonResponse,
  loggedInStore,
  mockFetch,
  runCleanups,
  site,
  tempDir,
  tempStore,
  writeTree,
} from './helpers.ts'

afterEach(runCleanups)

async function connect(
  store: ConfigStore,
  fetchImpl?: FetchLike,
  cwd?: string,
  extra: Partial<McpDeps> = {}
) {
  // Never search the real machine: home is an empty temp folder unless a test sets one.
  const home = extra.locate?.home ?? (await tempDir())
  const server = createMcpServer({
    store,
    fetch: fetchImpl,
    cwd,
    ...extra,
    locate: { cwd: cwd ?? home, home, platform: process.platform, env: {}, ...extra.locate },
  })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  return client
}

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? ''
const dataOf = (r: unknown) => JSON.parse(text(r).slice(text(r).indexOf('\n\n') + 2))
const manifestPaths = (m: ReturnType<typeof mockFetch>, i = 0) =>
  (
    JSON.parse(String(m.calls.filter(c => c.method === 'POST')[i]?.init.body)).manifest.files as {
      path: string
    }[]
  ).map(f => f.path)

describe('MCP server', () => {
  it('lists the tools', async () => {
    const { store } = await tempStore()
    const client = await connect(store)
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual([
      'fling_archive',
      'fling_check_name',
      'fling_delete',
      'fling_deploy',
      'fling_find_files',
      'fling_info',
      'fling_list',
      'fling_login',
      'fling_publish',
      'fling_rollback',
      'fling_set_visibility',
      'fling_share',
      'fling_whoami',
    ])
    const del = tools.find(t => t.name === 'fling_delete')
    expect(del?.inputSchema.required).toEqual(expect.arrayContaining(['name', 'confirm']))
    expect(tools.find(t => t.name === 'fling_deploy')?.inputSchema.required).toEqual(['path'])
    // Shared with the remote connector: same description and shape.
    const publish = tools.find(t => t.name === 'fling_publish')
    expect(publish?.inputSchema.required).toEqual(['name', 'files'])
    expect(Object.keys(publish?.inputSchema.properties ?? {})).toEqual(
      Object.keys(mcpTools.publish.inputSchema)
    )
    expect(publish?.description).not.toMatch(/fling_upload_begin/)
    expect(tools.find(t => t.name === 'fling_list')?.description).toBe(mcpTools.list.description)
    expect(client.getInstructions()).toMatch(/never pass file paths from your sandbox/i)
    expect(client.getInstructions()).toMatch(/fling_login/)
  })

  it('tells the agent to have the user log in when there is no key', async () => {
    const { store } = await tempStore()
    const client = await connect(store)
    const res = await client.callTool({ name: 'fling_whoami', arguments: {} })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/npx @nearform\/fling login/)
  })

  it('maps a 401 to the same login hint', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      '/api/me': () => jsonResponse({ error: { code: 'unauthorized', message: 'revoked' } }, 401),
    })
    const client = await connect(store, m.fetch)
    const res = await client.callTool({ name: 'fling_whoami', arguments: {} })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/fling login/)
  })

  it('deploys a path relative to cwd', async () => {
    const store = await loggedInStore()
    const cwd = await tempDir()
    await writeTree(join(cwd, 'proj/dist'), { 'index.html': 'hi' })
    const m = mockFetch({
      'POST /api/sites/proj/deploys': () =>
        jsonResponse({
          status: 'unchanged',
          versionId: '0123456789abcdef',
          site: site({ name: 'proj' }),
        }),
    })
    const client = await connect(store, m.fetch, cwd)
    const res = await client.callTool({ name: 'fling_deploy', arguments: { path: 'proj/dist' } })
    expect(res.isError).toBeFalsy()
    expect(text(res)).toMatch(/^Unchanged — already live: https:\/\/my-app\.fling/)
  })

  it('fling_deploy without index.html asks for a listHtml decision, then lists or not', async () => {
    const store = await loggedInStore()
    const cwd = await tempDir()
    await writeTree(join(cwd, 'proj'), { 'page.html': '<title>P</title>', 'b.html': 'b' })
    const m = mockFetch({
      'POST /api/sites/proj/deploys': () =>
        jsonResponse({
          status: 'unchanged',
          versionId: '0123456789abcdef',
          site: site({ name: 'proj' }),
        }),
    })
    const client = await connect(store, m.fetch, cwd)
    const ask = await client.callTool({ name: 'fling_deploy', arguments: { path: 'proj' } })
    expect(ask.isError).toBeFalsy()
    expect(text(ask)).toMatch(/^Not published yet: there is no index\.html .* 2 HTML pages/)
    expect(text(ask)).toMatch(/listHtml: true/)
    expect(dataOf(ask)).toMatchObject({
      status: 'needs_decision',
      htmlPages: ['b.html', 'page.html'],
    })
    expect(m.calls).toHaveLength(0)

    const listed = await client.callTool({
      name: 'fling_deploy',
      arguments: { path: 'proj', listHtml: true },
    })
    expect(dataOf(listed)).toMatchObject({
      name: 'proj',
      nameGenerated: true,
      generatedIndex: true,
    })
    expect(manifestPaths(m, 0)).toEqual(['b.html', 'index.html', 'page.html'])

    const without = await client.callTool({
      name: 'fling_deploy',
      arguments: { path: 'proj', listHtml: false },
    })
    expect(dataOf(without).warnings).toEqual([expect.stringMatching(/No index\.html/)])
    expect(manifestPaths(m, 1)).toEqual(['b.html', 'page.html'])
  })

  it('fling_deploy finds a bare file name in Downloads and deploys it as index.html', async () => {
    const store = await loggedInStore()
    const home = await realpath(await tempDir())
    await writeTree(join(home, 'Downloads'), { 'Pitch Deck (1).html': '<h1>deck</h1>' })
    const m = mockFetch({
      'POST /api/sites/pitch-deck/deploys': () =>
        jsonResponse({
          status: 'unchanged',
          versionId: '0123456789abcdef',
          site: site({ name: 'pitch-deck' }),
        }),
    })
    const client = await connect(store, m.fetch, '/', { locate: { home } as McpDeps['locate'] })
    const res = await client.callTool({
      name: 'fling_deploy',
      arguments: { path: '/mnt/user-data/outputs/Pitch Deck.html' },
    })
    expect(res.isError).toBeFalsy()
    expect(text(res)).toMatch(/^Found "Pitch Deck \(1\)\.html" in Downloads: /)
    expect(dataOf(res).source).toMatchObject({ foundIn: 'Downloads', kind: 'html' })
    expect(manifestPaths(m)).toEqual(['index.html'])

    const missing = await client.callTool({
      name: 'fling_deploy',
      arguments: { path: 'nope.html' },
    })
    expect(missing.isError).toBe(true)
    expect(text(missing)).toMatch(/Could not find "nope\.html"/)
  })

  it('fling_find_files lists recent candidates', async () => {
    const { store } = await tempStore()
    const home = await realpath(await tempDir())
    await writeTree(join(home, 'Downloads'), {
      'deck.html': 'x',
      'site.zip': 'x',
      'notes.txt': 'x',
      'mysite/index.html': 'x',
    })
    const client = await connect(store, undefined, '/', { locate: { home } as McpDeps['locate'] })
    const res = await client.callTool({ name: 'fling_find_files', arguments: {} })
    expect(res.isError).toBeFalsy()
    const data = dataOf(res)
    expect(data.files.map((f: { path: string }) => f.path.slice(home.length)).sort()).toEqual(
      ['/Downloads/deck.html', '/Downloads/mysite', '/Downloads/site.zip'].map(p => join(p))
    )
    expect(data.files[0]).toMatchObject({ foundIn: 'Downloads' })
    expect(text(res)).toMatch(/^3 recent item\(s\), newest first:/)
  })

  it('fling_publish writes inline files (utf8 + base64) and deploys them', async () => {
    const store = await loggedInStore()
    const puts: { path: string; body: string }[] = []
    const m = mockFetch({
      'POST /api/sites/my-report/deploys': (_url, init) => {
        const files = JSON.parse(String(init.body)).manifest.files as { path: string }[]
        return jsonResponse({
          status: 'upload',
          versionId: '0123456789abcdef',
          uploads: files.map(f => ({
            path: f.path,
            url: `https://s3.test/put/${f.path}`,
            headers: {},
          })),
        })
      },
      'POST /api/sites/my-report/deploys/0123456789abcdef/finalize': () =>
        jsonResponse({
          status: 'live',
          versionId: '0123456789abcdef',
          site: site({ name: 'my-report' }),
        }),
    })
    const fetchWithPuts: FetchLike = async (input, init = {}) => {
      if (init.method === 'PUT') {
        puts.push({
          path: new URL(input).pathname.replace('/put/', ''),
          body: Buffer.from(init.body as Uint8Array).toString('utf8'),
        })
        return new Response(null, { status: 200 })
      }
      return m.fetch(input, init)
    }
    const client = await connect(store, fetchWithPuts)
    const res = await client.callTool({
      name: 'fling_publish',
      arguments: {
        name: 'my-report',
        files: [
          { path: './index.html', content: '<h1>Report</h1>' },
          {
            path: 'img/a.txt',
            content: Buffer.from('binary!').toString('base64'),
            encoding: 'base64',
          },
        ],
      },
    })
    expect(res.isError).toBeFalsy()
    expect(text(res)).toMatch(/^Deployed 2 files \(uploaded 2\): https:\/\//)
    expect(puts.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'img/a.txt', body: 'binary!' },
      { path: 'index.html', body: '<h1>Report</h1>' },
    ])

    const bad = await client.callTool({
      name: 'fling_publish',
      arguments: { name: 'my-report', files: [{ path: '../x.html', content: 'x' }] },
    })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toMatch(/Invalid file path/)
  })

  it('fling_publish without index.html asks for a listHtml decision', async () => {
    const store = await loggedInStore()
    const m = mockFetch({})
    const client = await connect(store, m.fetch)
    const res = await client.callTool({
      name: 'fling_publish',
      arguments: { name: 'pages', files: [{ path: 'a.html', content: 'a' }] },
    })
    expect(dataOf(res)).toMatchObject({ status: 'needs_decision', htmlPages: ['a.html'] })
    expect(text(res)).toMatch(/call fling_publish again/)
    expect(m.calls).toHaveLength(0)
  })

  it('fling_login signs in through the loopback callback', async () => {
    const { store } = await tempStore()
    const m = mockFetch({
      'GET /api/me': () =>
        jsonResponse({ email: 'me@nearform.com', name: 'Me', picture: null, userSlug: 'me' }),
    })
    const open = async (url: string) => {
      const u = new URL(url)
      const cb = new URL(u.searchParams.get('redirect_uri') as string)
      cb.searchParams.set('key', 'fling_k_0123456789abcdefghij')
      cb.searchParams.set('state', u.searchParams.get('state') as string)
      await fetch(cb)
    }
    const client = await connect(store, m.fetch, undefined, { open })
    const res = await client.callTool({ name: 'fling_login', arguments: {} })
    expect(text(res)).toMatch(/^Signed in as me@nearform\.com/)
    expect((await store.load()).apiKey).toBe('fling_k_0123456789abcdefghij')
    const again = await client.callTool({ name: 'fling_login', arguments: {} })
    expect(text(again)).toMatch(/^Already signed in .* as me@nearform\.com/)
  })

  it('fling_login returns after the wait and keeps listening in the background', async () => {
    const { store } = await tempStore()
    let opened = ''
    const client = await connect(store, mockFetch({}).fetch, undefined, {
      open: async url => {
        opened = url
      },
      loginWaitMs: 20,
      loginTimeoutMs: 200,
    })
    const res = await client.callTool({ name: 'fling_login', arguments: {} })
    expect(res.isError).toBeFalsy()
    expect(text(res)).toMatch(/^Finish signing in in your browser, then try again/)
    expect(text(res)).toContain(opened)
    await new Promise(r => setTimeout(r, 300)) // let the background listener time out and close
  })

  it('fling_deploy with a taken generated name errors with suggestions and asks to choose', async () => {
    const store = await loggedInStore()
    const cwd = await tempDir()
    await writeTree(join(cwd, 'proj'), { 'index.html': 'hi' })
    const m = mockFetch({
      'POST /api/sites/proj/deploys': () =>
        jsonResponse(
          { error: { code: 'name_taken', message: 'taken', suggestions: ['proj-cc', 'proj-cc2'] } },
          409
        ),
    })
    const client = await connect(store, m.fetch, cwd)
    const res = await client.callTool({ name: 'fling_deploy', arguments: { path: 'proj' } })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/"proj" \(generated from the folder\) is taken/)
    expect(text(res)).toMatch(/proj-cc, proj-cc2/)
    expect(text(res)).toMatch(/Ask the user/)
  })

  it('fling_check_name checks a name, or the name generated for a path', async () => {
    const store = await loggedInStore()
    const cwd = await tempDir()
    await writeTree(join(cwd, 'proj/dist'), { 'index.html': 'hi' })
    const m = mockFetch({
      'GET /api/names/taken-one': () =>
        jsonResponse({ name: 'taken-one', status: 'taken', suggestions: ['taken-one-cc'] }),
      'GET /api/names/proj': () =>
        jsonResponse({ name: 'proj', status: 'available', suggestions: [] }),
    })
    const client = await connect(store, m.fetch, cwd)
    const taken = await client.callTool({
      name: 'fling_check_name',
      arguments: { name: 'taken-one' },
    })
    expect(taken.isError).toBeFalsy()
    expect(text(taken)).toMatch(/^"taken-one" is taken by someone else\. Suggestions: taken-one-cc/)

    const gen = await client.callTool({
      name: 'fling_check_name',
      arguments: { path: 'proj/dist' },
    })
    expect(text(gen)).toMatch(/^"proj" is available → http:\/\/proj\.server\.test\//)
    expect(JSON.parse(text(gen).slice(text(gen).indexOf('\n\n') + 2))).toMatchObject({
      name: 'proj',
      status: 'available',
      generated: true,
    })

    const neither = await client.callTool({ name: 'fling_check_name', arguments: {} })
    expect(neither.isError).toBe(true)
  })

  it('fling_delete requires confirm: true', async () => {
    const store = await loggedInStore()
    const m = mockFetch({ 'DELETE /api/sites/my-app': () => new Response(null, { status: 204 }) })
    const client = await connect(store, m.fetch)
    const refused = await client.callTool({ name: 'fling_delete', arguments: { name: 'my-app' } })
    expect(refused.isError).toBe(true)
    expect(m.calls).toHaveLength(0)
    const ok = await client.callTool({
      name: 'fling_delete',
      arguments: { name: 'my-app', confirm: true },
    })
    expect(ok.isError).toBeFalsy()
    expect(m.calls.map(c => c.method)).toEqual(['DELETE'])
  })
})
