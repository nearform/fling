import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { mcpTools } from '@fling/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/api.ts'
import { type ConfigStore, createConfigStore, serverToAdd } from '../src/config.ts'
import { createMcpServer, type McpDeps } from '../src/mcp.ts'
import { addServerOnStart, type KnownServer, knownServers } from '../src/mcp-servers.ts'
import { NPX_COMMAND } from '../src/package-info.ts'
import {
  INSTANCE,
  instanceRoute,
  jsonResponse,
  loggedInStore,
  mockFetch,
  runCleanups,
  SERVER,
  site,
  TEST_KEY,
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

/** A Fling the descriptions name, as runMcpServer reads it at start. */
const known = (instance = INSTANCE, url = SERVER): KnownServer => ({
  url,
  instance,
  current: true,
  signedIn: true,
})

/** The description of a listed tool's `server` argument. */
const serverArgOf = (tool: { inputSchema: { properties?: Record<string, unknown> } } | undefined) =>
  (tool?.inputSchema.properties?.server as { description?: string } | undefined)?.description

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? ''
const dataOf = (r: unknown) => JSON.parse(text(r).slice(text(r).indexOf('\n\n') + 2))
const manifestPaths = (m: ReturnType<typeof mockFetch>, i = 0) =>
  (
    JSON.parse(String(m.calls.filter(c => c.method === 'POST')[i]?.init.body)).manifest.files as {
      path: string
    }[]
  ).map(f => f.path)

const OTHER = 'https://fling.other.test'
const OTHER_KEY = 'fling_other_key_0123456789'
const OTHER_INSTANCE = { ...INSTANCE, name: 'Other Fling', appOrigin: OTHER }
const NEW_KEY = 'fling_k_0123456789abcdefghij'

/** SERVER (current) and OTHER, both signed in. */
async function twoFlings() {
  const { store } = await tempStore()
  await store.putServer(SERVER, {
    instance: INSTANCE,
    apiKey: TEST_KEY,
    user: { email: 'ada@example.test' },
  })
  await store.putServer(OTHER, {
    instance: OTHER_INSTANCE,
    apiKey: OTHER_KEY,
    user: { email: 'ada@other.test' },
  })
  return store
}

const meFetch = () =>
  mockFetch({
    'GET /api/me': () =>
      jsonResponse({ email: 'me@example.test', name: 'Me', picture: null, userSlug: 'me' }),
  })

/** Where the last /api/me call went, and with which key. */
function lastMe(m: ReturnType<typeof mockFetch>) {
  const me = m.calls.filter(c => c.url.pathname === '/api/me').at(-1)
  return {
    origin: me?.url.origin,
    auth: (me?.init.headers as Record<string, string> | undefined)?.Authorization,
  }
}

/** A stand-in for the browser: completes the sign-in with `key`. */
function browserGiving(key: string) {
  return async (url: string) => {
    const u = new URL(url)
    const cb = new URL(u.searchParams.get('redirect_uri') as string)
    cb.searchParams.set('key', key)
    cb.searchParams.set('state', u.searchParams.get('state') as string)
    await fetch(cb)
  }
}

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
      'fling_files',
      'fling_find_files',
      'fling_info',
      'fling_list',
      'fling_login',
      'fling_publish',
      'fling_rollback',
      'fling_servers',
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
    expect(Object.keys(publish?.inputSchema.properties ?? {})).toEqual([
      ...Object.keys(mcpTools.publish.inputSchema),
      'server',
    ])
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
    expect(text(res)).toContain(`${NPX_COMMAND} login`)
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

  it('fling_list lists the last updated first, or in the order `sort` asks for', async () => {
    const store = await loggedInStore()
    const sites = [
      site({ name: 'beta', updatedAt: '2026-10-03T00:00:00.000Z' }),
      site({ name: 'alpha', updatedAt: '2026-10-02T00:00:00.000Z' }),
      site({ name: 'gamma', updatedAt: '2026-10-04T00:00:00.000Z' }),
    ]
    const m = mockFetch({ '/api/sites': () => jsonResponse({ sites }) })
    const client = await connect(store, m.fetch)
    const names = async (args: Record<string, unknown>) =>
      (
        dataOf(await client.callTool({ name: 'fling_list', arguments: args })).sites as {
          name: string
        }[]
      ).map(s => s.name)
    expect(await names({})).toEqual(['gamma', 'beta', 'alpha'])
    expect(await names({ sort: 'name' })).toEqual(['alpha', 'beta', 'gamma'])
    const bad = await client.callTool({ name: 'fling_list', arguments: { sort: 'size' } })
    expect(bad.isError).toBe(true)
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
    expect(text(res)).toMatch(/^Unchanged — already live\./)
    expect(text(res)).toContain('Site: https://my-app.sites.example.test/ (private)')
    expect(text(res)).toContain('\nFling: server.test (Example Fling)')
    expect(dataOf(res)).toMatchObject({ server: SERVER })
  })

  it('with comments on, a deploy leads with the review link to share, then the site URL', async () => {
    const store = await loggedInStore()
    const cwd = await tempDir()
    await writeTree(join(cwd, 'proj'), { 'index.html': 'hi' })
    const m = mockFetch({
      'POST /api/sites/proj/deploys': () =>
        jsonResponse({ status: 'unchanged', versionId: '0123456789abcdef', site: site() }),
    })
    const client = await connect(store, m.fetch, cwd, { servers: [known(INSTANCE)] })
    expect(client.getInstructions()).toContain('the review link first')
    const res = await client.callTool({ name: 'fling_deploy', arguments: { path: 'proj' } })
    const lines = text(res).split('\n')
    expect(lines[0]).toBe('Unchanged — already live.')
    expect(lines[1]).toBe(
      `Share for feedback: ${SERVER}/review/proj (reviewers sign in to ${INSTANCE.name} to see the site and comment).`
    )
    expect(lines[2]).toMatch(/^Site: https:\/\/my-app\.sites\.example\.test\/ \(private\)/)
    expect(text(res)).toContain(`"reviewUrl": "${SERVER}/review/proj"`)

    await store.putServer(SERVER, { instance: { ...INSTANCE, capabilities: { comments: false } } })
    const off = await connect(store, m.fetch, cwd)
    const plain = await off.callTool({ name: 'fling_deploy', arguments: { path: 'proj' } })
    expect(text(plain)).not.toContain('/review/')
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
    expect(text(res)).toMatch(/^Deployed 2 files \(uploaded 2\)\.\n/)
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
      ...instanceRoute,
      'GET /api/me': () =>
        jsonResponse({ email: 'me@example.test', name: 'Me', picture: null, userSlug: 'me' }),
    })
    const open = async (url: string) => {
      const u = new URL(url)
      const cb = new URL(u.searchParams.get('redirect_uri') as string)
      cb.searchParams.set('key', 'fling_k_0123456789abcdefghij')
      cb.searchParams.set('state', u.searchParams.get('state') as string)
      await fetch(cb)
    }
    // `fling mcp --server` (or FLING_URL) pins the server.
    const client = await connect(store, m.fetch, undefined, { open, server: SERVER })
    const res = await client.callTool({ name: 'fling_login', arguments: {} })
    expect(text(res)).toMatch(/^Signed in as me@example\.test/)
    expect((await store.load()).servers[SERVER]).toMatchObject({
      instance: INSTANCE,
      apiKey: 'fling_k_0123456789abcdefghij',
    })
    const again = await client.callTool({ name: 'fling_login', arguments: {} })
    expect(text(again)).toMatch(/^Already signed in .* as me@example\.test/)
  })

  it('with one Fling, uses it without `server`, re-read on every call', async () => {
    const other = 'https://fling.other.test'
    const { store } = await tempStore()
    await store.putServer(SERVER, { instance: INSTANCE, apiKey: TEST_KEY })
    const m = meFetch()
    const client = await connect(store, m.fetch)
    const res = await client.callTool({ name: 'fling_whoami', arguments: {} })
    expect(text(res)).toMatch(/^Signed in to server\.test \(Example Fling\) as me@example\.test/)
    expect(lastMe(m)).toEqual({ origin: SERVER, auth: `Bearer ${TEST_KEY}` })

    // `fling logout <url>` of it and `fling login` elsewhere in a terminal: the next call follows.
    await store.removeServer(SERVER)
    await store.putServer(other, { apiKey: OTHER_KEY })
    await client.callTool({ name: 'fling_whoami', arguments: {} })
    expect(lastMe(m)).toEqual({ origin: other, auth: `Bearer ${OTHER_KEY}` })
  })

  it('with several Flings, a call without `server` does not run and lists them', async () => {
    const store = await twoFlings()
    const m = meFetch()
    const client = await connect(store, m.fetch)
    for (const name of ['fling_whoami', 'fling_list', 'fling_login']) {
      const res = await client.callTool({ name, arguments: {} })
      expect(res.isError).toBeFalsy()
      expect(text(res)).toMatch(new RegExp(`^Not run: several Flings .* ${name} needs \`server\``))
      expect(text(res)).toContain(
        "- server.test (Example Fling; signed in as ada@example.test; current: the user's usual one)"
      )
      expect(text(res)).toContain('- fling.other.test (Other Fling; signed in as ada@other.test)')
      expect(text(res)).toMatch(/ask the user/)
      expect(dataOf(res)).toMatchObject({
        status: 'needs_server',
        servers: [
          { url: SERVER, current: true, signedIn: true },
          { url: OTHER, current: false, instance: 'Other Fling' },
        ],
      })
    }
    expect(m.calls).toHaveLength(0)
  })

  it('a `server` argument routes the call to that Fling with its key', async () => {
    const store = await twoFlings()
    const m = meFetch()
    const client = await connect(store, m.fetch)
    for (const server of ['fling.other.test', OTHER, 'other.test', `${OTHER}/`]) {
      await client.callTool({ name: 'fling_whoami', arguments: { server } })
      expect(lastMe(m)).toEqual({ origin: OTHER, auth: `Bearer ${OTHER_KEY}` })
    }
    await client.callTool({ name: 'fling_whoami', arguments: { server: 'server.test' } })
    expect(lastMe(m)).toEqual({ origin: SERVER, auth: `Bearer ${TEST_KEY}` })
    // The current Fling is untouched.
    expect((await store.load()).current).toBe(SERVER)
  })

  it('an unknown or ambiguous `server` fails and lists the Flings', async () => {
    const store = await twoFlings()
    const m = meFetch()
    const client = await connect(store, m.fetch)
    const unknown = await client.callTool({
      name: 'fling_list',
      arguments: { server: 'fling.nowhere.test' },
    })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toMatch(/^"fling\.nowhere\.test" is not a Fling set up on this computer/)
    expect(text(unknown)).toContain('- fling.other.test (Other Fling')
    expect(text(unknown)).toMatch(/call fling_login with its address/)

    await store.putServer('https://fling.third.test', {})
    const ambiguous = await client.callTool({ name: 'fling_list', arguments: { server: 'fling' } })
    expect(ambiguous.isError).toBe(true)
    expect(text(ambiguous)).toMatch(/matches more than one server/)
    expect(text(ambiguous)).toContain('- fling.third.test (signed out)')
    expect(m.calls).toHaveLength(0)
  })

  it('fling_servers lists the Flings live and switches the current one like `fling use`', async () => {
    const store = await twoFlings()
    const client = await connect(store, meFetch().fetch)
    const listed = await client.callTool({ name: 'fling_servers', arguments: {} })
    expect(text(listed)).toMatch(/^2 Fling\(s\) set up on this computer:/)
    expect(text(listed)).toMatch(/Pass `server` on every call/)
    expect(dataOf(listed)).toEqual({
      current: SERVER,
      servers: [
        {
          url: SERVER,
          host: 'server.test',
          instance: 'Example Fling',
          signedIn: true,
          email: 'ada@example.test',
          current: true,
        },
        {
          url: OTHER,
          host: 'fling.other.test',
          instance: 'Other Fling',
          signedIn: true,
          email: 'ada@other.test',
          current: false,
        },
      ],
    })
    // Read live: a Fling added since start shows up.
    await store.putServer('https://fling.third.test', {})
    const used = await client.callTool({ name: 'fling_servers', arguments: { use: 'other.test' } })
    expect(text(used)).toMatch(/^Now using fling\.other\.test as the current Fling/)
    expect(text(used)).toContain('- fling.third.test (signed out)')
    expect((await store.load()).current).toBe(OTHER)
    const bad = await client.callTool({ name: 'fling_servers', arguments: { use: 'nowhere.test' } })
    expect(bad.isError).toBe(true)
  })

  it('FLING_URL or --server pins the Fling calls without `server` go to', async () => {
    const store = await twoFlings()
    const m = meFetch()
    const pinned = await connect(
      createConfigStore({ dir: store.dir, env: { FLING_URL: `${OTHER}/` } }),
      m.fetch
    )
    await pinned.callTool({ name: 'fling_whoami', arguments: {} })
    expect(lastMe(m)).toEqual({ origin: OTHER, auth: `Bearer ${OTHER_KEY}` })
    const flag = await connect(store, m.fetch, undefined, { server: 'other.test' })
    await flag.callTool({ name: 'fling_whoami', arguments: {} })
    expect(lastMe(m)).toEqual({ origin: OTHER, auth: `Bearer ${OTHER_KEY}` })
    // An unsubstituted extension placeholder pins nothing.
    const placeholder = await connect(
      createConfigStore({
        dir: store.dir,
        env: { FLING_URL: ['$', '{user_config.server_url}'].join('') },
      }),
      m.fetch
    )
    const refused = await placeholder.callTool({ name: 'fling_whoami', arguments: {} })
    expect(dataOf(refused)).toMatchObject({ status: 'needs_server' })
  })

  it('fling_login with `server` signs in to a new Fling without making it current', async () => {
    const { store } = await tempStore()
    await store.putServer(OTHER, { apiKey: OTHER_KEY })
    const m = mockFetch({
      ...instanceRoute,
      'GET /api/me': () =>
        jsonResponse({ email: 'me@example.test', name: 'Me', picture: null, userSlug: 'me' }),
    })
    const client = await connect(store, m.fetch, undefined, { open: browserGiving(NEW_KEY) })
    const res = await client.callTool({ name: 'fling_login', arguments: { server: SERVER } })
    expect(text(res)).toBe(`Signed in as me@example.test (${SERVER}, Example Fling).`)
    const config = await store.load()
    expect(config.current).toBe(OTHER)
    expect(config.servers[SERVER]).toMatchObject({ instance: INSTANCE, apiKey: NEW_KEY })
    expect(config.servers[OTHER]?.apiKey).toBe(OTHER_KEY)
  })

  it('fling_login with `server` and no Fling current makes it current', async () => {
    const { store } = await tempStore()
    const client = await connect(
      store,
      mockFetch({
        ...instanceRoute,
        'GET /api/me': () =>
          jsonResponse({ email: 'me@example.test', name: 'Me', picture: null, userSlug: 'me' }),
      }).fetch,
      undefined,
      { open: browserGiving(NEW_KEY) }
    )
    await client.callTool({ name: 'fling_login', arguments: { server: 'server.test' } })
    expect((await store.load()).current).toBe('https://server.test')
  })

  it('fling_login for the pinned server keeps the current server', async () => {
    const other = 'https://fling.other.test'
    const { store } = await tempStore()
    await store.putServer(other, { apiKey: 'fling_other_key_0123456789' })
    const m = mockFetch({
      ...instanceRoute,
      'GET /api/me': () =>
        jsonResponse({ email: 'me@example.test', name: 'Me', picture: null, userSlug: 'me' }),
    })
    const open = async (url: string) => {
      const u = new URL(url)
      const cb = new URL(u.searchParams.get('redirect_uri') as string)
      cb.searchParams.set('key', 'fling_k_0123456789abcdefghij')
      cb.searchParams.set('state', u.searchParams.get('state') as string)
      await fetch(cb)
    }
    const extension = createConfigStore({ dir: store.dir, env: { FLING_URL: SERVER } })
    const client = await connect(extension, m.fetch, undefined, { open })
    expect(text(await client.callTool({ name: 'fling_login', arguments: {} }))).toMatch(
      /^Signed in as me@example\.test/
    )
    const config = await store.load()
    expect(config.current).toBe(other)
    expect(config.servers[SERVER]?.apiKey).toBe('fling_k_0123456789abcdefghij')
    expect(config.servers[other]?.apiKey).toBe('fling_other_key_0123456789')
  })

  it('fling_login returns after the wait and keeps listening in the background', async () => {
    const { store } = await tempStore()
    let opened = ''
    const client = await connect(store, mockFetch(instanceRoute).fetch, undefined, {
      server: SERVER,
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

  it('fling_login without any server asks the user to log in with their Fling address', async () => {
    const { store } = await tempStore()
    const client = await connect(store)
    const res = await client.callTool({ name: 'fling_login', arguments: {} })
    expect(res.isError).toBe(true)
    expect(text(res)).toContain(`${NPX_COMMAND} login <url>`)
  })

  it('names the logged-in instance in its descriptions, and stays generic before a login', async () => {
    const named = await connect(await loggedInStore(), undefined, undefined, {
      servers: [known(INSTANCE)],
    })
    expect(named.getInstructions()).toMatch(
      /^Example Fling publishes static sites .* at https:\/\/<name>\.sites\.example\.test\./
    )
    const tools = (await named.listTools()).tools
    expect(tools.find(t => t.name === 'fling_set_visibility')?.description).toContain(
      'anyone signed in to Example Fling (@example.test accounts)'
    )
    expect(tools.find(t => t.name === 'fling_login')?.description).toContain('Example SSO account')
    const generic = await connect((await tempStore()).store)
    expect(generic.getInstructions()).toContain('https://<name>.<sites domain>')
  })

  it('with several Flings, the instructions and descriptions list them and say to settle one first', async () => {
    const store = await twoFlings()
    const servers = await knownServers(store, meFetch().fetch)
    const client = await connect(store, undefined, undefined, { servers })
    const instructions = client.getInstructions() ?? ''
    expect(instructions).toContain('Several Flings are set up on this computer:')
    expect(instructions).toContain(
      "- server.test (Example Fling; signed in as ada@example.test; current: the user's usual one)"
    )
    expect(instructions).toContain('- fling.other.test (Other Fling; signed in as ada@other.test)')
    expect(instructions).toMatch(/Settle which one this conversation uses before anything else/)
    expect(instructions).toMatch(/suggest server\.test, their usual one/)
    expect(instructions).toMatch(/pass it as `server` on every call/)
    expect(instructions).toMatch(/switch only when the user asks/)
    expect(instructions).toMatch(/call fling_servers/)
    // Instance names can be the same, so the generic wording, and hosts, not names.
    expect(instructions).toMatch(/^Fling publishes static sites/)
    const tools = (await client.listTools()).tools
    const list = tools.find(t => t.name === 'fling_list')
    expect(list?.description).toContain('several Flings are set up (server.test, fling.other.test)')
    expect(serverArgOf(list)).toMatch(/^Which Fling: server\.test, fling\.other\.test .*Required/)
    expect(
      tools.find(t => t.name === 'fling_find_files')?.inputSchema.properties
    ).not.toHaveProperty('server')
  })

  it('with one Fling, the wording stays as simple as before', async () => {
    const store = await loggedInStore()
    const client = await connect(store, undefined, undefined, {
      servers: await knownServers(store, meFetch().fetch),
    })
    expect(client.getInstructions()).not.toMatch(/Several Flings/)
    expect(client.getInstructions()).toMatch(/^Example Fling publishes static sites/)
    const list = (await client.listTools()).tools.find(t => t.name === 'fling_list')
    expect(list?.description).toBe(mcpTools.list.description)
    expect(serverArgOf(list)).toMatch(/Omit it to use server\.test$/)
  })

  it('on start, remembers the Fling the extension came from without taking over current', async () => {
    const { store } = await tempStore()
    await store.putServer(OTHER, { apiKey: OTHER_KEY })
    const m = mockFetch(instanceRoute)
    await addServerOnStart(store, serverToAdd({ FLING_ADD_SERVER: SERVER }), m.fetch)
    let config = await store.load()
    expect(config.current).toBe(OTHER)
    expect(config.servers[SERVER]).toEqual({ instance: INSTANCE })

    // Known already: its entry (and key) is left alone, and nothing is fetched.
    await store.putServer(SERVER, { apiKey: TEST_KEY })
    const calls = m.calls.length
    await addServerOnStart(store, `${SERVER}/`, m.fetch)
    expect((await store.load()).servers[SERVER]).toEqual({ instance: INSTANCE, apiKey: TEST_KEY })
    expect(m.calls).toHaveLength(calls)

    // With none current it becomes current; unreachable, it is still remembered.
    const fresh = (await tempStore()).store
    await addServerOnStart(fresh, OTHER, async () => {
      throw new Error('offline')
    })
    config = await fresh.load()
    expect(config).toEqual({ current: OTHER, servers: { [OTHER]: {} } })
  })

  it('ignores an unsubstituted FLING_ADD_SERVER placeholder', async () => {
    expect(serverToAdd({ FLING_ADD_SERVER: ['$', '{user_config.server_url}'].join('') })).toBe(
      undefined
    )
    expect(serverToAdd({ FLING_ADD_SERVER: '  ' })).toBe(undefined)
    expect(serverToAdd({})).toBe(undefined)
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
    expect(text(gen)).toMatch(/^"proj" is available → https:\/\/proj\.sites\.example\.test\//)
    expect(JSON.parse(text(gen).slice(text(gen).indexOf('\n\n') + 2))).toMatchObject({
      name: 'proj',
      status: 'available',
      generated: true,
    })

    const neither = await client.callTool({ name: 'fling_check_name', arguments: {} })
    expect(neither.isError).toBe(true)
  })

  it('fling_files lists the served version and warns when the root has no index.html', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      'GET /api/sites/my-app': () => jsonResponse({ ...site(), versions: [] }),
      'GET /api/sites/my-app/versions/abcdef0123456789/files': () =>
        jsonResponse({
          versionId: 'abcdef0123456789',
          files: [{ path: 'hello.html', size: 12, contentType: 'text/html' }],
          totalBytes: 12,
          generatedIndex: false,
        }),
    })
    const client = await connect(store, m.fetch)
    const r = await client.callTool({ name: 'fling_files', arguments: { name: 'my-app' } })
    expect(r.isError).toBeFalsy()
    expect(text(r)).toMatch(/my-app current version abcdef0123456789: 1 file, 12 B/)
    expect(text(r)).toMatch(/no index\.html at the root/)
    expect(text(r)).toContain('- hello.html (12 B, text/html)')
    expect(dataOf(r)).toMatchObject({ current: true, files: [{ path: 'hello.html' }] })
  })

  it('fling_share waits for a new link to reach the edge and says so when it has not', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      'GET /api/sites/my-app': () => jsonResponse({ ...site(), versions: [] }),
      'POST /api/sites/my-app/share': () => jsonResponse({ shareUrl: 'https://s-new.test/' }),
      'GET /api/sites/my-app/versions/abcdef0123456789/files': () =>
        jsonResponse({
          versionId: 'abcdef0123456789',
          files: [{ path: 'index.html', size: 1, contentType: 'text/html' }],
          totalBytes: 1,
          generatedIndex: false,
        }),
    })
    const waited: string[] = []
    const client = await connect(store, m.fetch, undefined, {
      waitReady: async url => {
        waited.push(url)
        return { ready: false, waitedMs: 15_000 }
      },
    })
    const r = await client.callTool({ name: 'fling_share', arguments: { name: 'my-app' } })
    expect(waited).toEqual(['https://s-new.test/'])
    expect(text(r)).toMatch(/reload if you see a 404/)
    expect(dataOf(r)).toMatchObject({ action: 'created', ready: false })
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
