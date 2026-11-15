import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  describeServerError,
  type FlingServerHelpers,
  type InstanceMetadata,
  SERVER_BUNDLE,
  SERVER_HELPER_MODULE,
  SERVER_TEMPLATE,
  SERVER_TEMPLATE_CONFIG,
  unbundledImports,
} from '@fling/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { runDeploy } from '../src/commands/deploy.ts'
import { runLogs, runSecretsList, runSecretsSet } from '../src/commands/servers.ts'
import { startDevServer } from '../src/dev-server.ts'
import { localSecrets, pickEnv } from '../src/dotenv.ts'
import type * as Helpers from '../src/server/index.d.ts'
import { buildSiteManifest, describeBundle, findServer, isBuildInput } from '../src/server-build.ts'
import { describeSecretOutcome, newLogLines } from '../src/site-server.ts'
import {
  captureError,
  INSTANCE,
  jsonResponse,
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
const SERVERS_ON: InstanceMetadata = {
  ...INSTANCE,
  capabilities: {
    ...INSTANCE.capabilities,
    accessLevels: true,
    servers: true,
    serversEgress: true,
  },
}

async function serversStore(instance = SERVERS_ON) {
  const { store } = await tempStore()
  await store.putServer(SERVER, { instance, apiKey: TEST_KEY })
  return store
}

/** A folder with a server that imports an npm package (in its node_modules) and the helper. */
async function serverFolder(extra: Record<string, string> = {}) {
  const root = await tempDir()
  const dir = join(root, 'my-app')
  await writeTree(dir, {
    'index.html': '<h1>hi</h1>',
    'server.ts': [
      "import { createServer } from 'http'",
      `import { viewer } from '${SERVER_HELPER_MODULE}'`,
      "import { greet } from 'greeter'",
      "import costs from './server/costs.json'",
      'void createServer',
      'export default { fetch: (r: Request) => Response.json({ hi: greet(viewer(r)?.email), c: costs.n }) }',
    ].join('\n'),
    'server/costs.json': '{"n": 3}',
    'fling.json': JSON.stringify({ secrets: ['API_KEY'], health: '/api/health' }),
    'package.json': '{"private":true}',
    'package-lock.json': '{}',
    'node_modules/greeter/package.json': '{"name":"greeter","main":"index.js"}',
    'node_modules/greeter/index.js': 'exports.greet = n => "hello " + n',
    ...extra,
  })
  return dir
}

describe('the server helper types', () => {
  it('match the shared contract both ways', () => {
    const shipped: typeof Helpers = {} as never
    const contract: FlingServerHelpers = {
      viewer: shipped.viewer,
      file: shipped.file,
      secret: shipped.secret,
    }
    const back: Pick<typeof Helpers, 'viewer' | 'file' | 'secret'> = contract
    expect(back).toBeDefined()
  })
})

describe('bundling and build inputs', () => {
  it('bundles the entry with its dependencies, keeps node:* and the helper outside, leaves the build inputs behind', async () => {
    const dir = await serverFolder()
    const built = await buildSiteManifest(dir, { servers: true })
    const paths = built.local.files.map(f => f.path)
    expect(paths).toEqual(['_fling/server.mjs', 'index.html'])
    expect(built.server?.buildInputs.sort()).toEqual(
      ['package-lock.json', 'package.json', 'server.ts', 'server/'].sort()
    )
    const bundle = built.local.files.find(f => f.path === SERVER_BUNDLE)?.content?.toString() ?? ''
    expect(bundle).toContain('hello ')
    expect(bundle).toContain('"node:http"')
    expect(bundle).toContain(SERVER_HELPER_MODULE)
    expect(unbundledImports(bundle, SERVER_HELPER_MODULE)).toEqual([])
    expect(built.server?.config).toEqual({ secrets: ['API_KEY'], health: '/api/health' })
    expect(describeBundle(built.server as never)).toMatch(
      /^bundling server\.ts → _fling\/server\.mjs \(.+, .+ gzipped\)$/
    )
  })

  it('takes the entry fling.json names, and refuses one that is missing', async () => {
    const dir = await serverFolder({ 'fling.json': '{"server":"src/api.js"}' })
    expect(await captureError(findServer(dir))).toMatchObject({
      message: expect.stringContaining('src/api.js'),
    })
    await writeTree(dir, { 'src/api.js': 'export default { fetch: () => new Response("ok") }' })
    expect((await findServer(dir))?.entry).toBe('src/api.js')
  })

  it('publishes a prebuilt _fling/server.mjs as it is, and refuses one with a bare import', async () => {
    const root = await tempDir()
    await writeTree(root, {
      'index.html': 'x',
      '_fling/server.mjs': 'export default { fetch: () => new Response("ok") }',
      'fling.json': '{"health":"/api/health"}',
    })
    const built = await buildSiteManifest(root, { servers: true })
    expect(built.server).toMatchObject({ entry: null, config: { health: '/api/health' } })
    expect(built.local.files.map(f => f.path)).toEqual(['_fling/server.mjs', 'index.html'])

    await writeTree(root, { '_fling/server.mjs': "import { Hono } from 'hono'\nexport default {}" })
    expect((await captureError(buildSiteManifest(root, { servers: true }))).message).toMatch(
      /imports hono/
    )
  })

  it('reports a dependency that is not installed', async () => {
    const root = await tempDir()
    await writeTree(root, { 'server.js': "import x from 'not-installed'\nexport default x" })
    const error = await captureError(buildSiteManifest(root, { servers: true }))
    expect(error.message).toMatch(/Could not bundle server\.js/)
    expect(error.hint).toMatch(/npm install/)
  })

  it('refuses a secret in the bundle', async () => {
    const root = await tempDir()
    await writeTree(root, {
      'server.js': `export const key = 'sk-ant-api03-${'a'.repeat(90)}AA'\nexport default {}`,
    })
    expect((await captureError(buildSiteManifest(root, { servers: true }))).code).toBe(
      'secret_detected'
    )
  })

  it('on a Fling without servers: refuses a fling.json, and publishes a bare server.js as a file', async () => {
    const dir = await serverFolder()
    expect(
      (await captureError(buildSiteManifest(dir, { servers: false, instanceName: 'X' }))).message
    ).toBe("X doesn't run site servers")
    const root = await tempDir()
    await writeTree(root, { 'index.html': 'x', 'server.js': 'console.log(1)' })
    const built = await buildSiteManifest(root, { servers: false })
    expect(built.server).toBeNull()
    expect(built.local.files.map(f => f.path)).toEqual(['index.html', 'server.js'])
    expect(built.notes[0]).toMatch(/server\.js is published as a file/)
  })

  it('never publishes fling.json, with or without a server', async () => {
    const root = await tempDir()
    await writeTree(root, { 'index.html': 'x', 'fling.json': '{}', 'package.json': '{}' })
    const built = await buildSiteManifest(root, { servers: true })
    expect(built.local.files.map(f => f.path)).toEqual(['index.html', 'package.json'])
    expect(
      isBuildInput(
        { entry: 'server.ts', config: { secrets: [] }, configFile: true },
        'server',
        true
      )
    ).toBe(true)
  })
})

describe('.env files', () => {
  it('reads only the declared names, .env.local over .env, and names the missing ones', async () => {
    const dir = await tempDir()
    await writeTree(dir, {
      '.env': 'A=from-env\nB=b\nDATABASE_URL=postgres://x\n',
      '.env.local': 'A=from-local\n',
    })
    const found = await localSecrets(dir, ['A', 'B', 'C'])
    expect(found.values).toEqual({ A: 'from-local', B: 'b' })
    expect(found.from).toEqual({ A: '.env.local', B: '.env' })
    expect(found.missing).toEqual(['C'])
  })

  it('pickEnv reads only the named keys', async () => {
    const dir = await tempDir()
    await writeTree(dir, { '.env': 'A=1\nB=2\n' })
    expect(await pickEnv(join(dir, '.env'), ['B'])).toEqual({ B: '2' })
    expect((await captureError(pickEnv(join(dir, '.env'), ['C']))).message).toMatch(/has no C/)
  })
})

describe('fling secrets', () => {
  const put = (body: unknown) =>
    jsonResponse({
      name: 'API_KEY',
      setBy: 'ada@example.test',
      setAt: '2026-11-15T06:00:00Z',
      ...(body as object),
    })

  it('sets a value from stdin (one trailing newline dropped) and prints what it deployed', async () => {
    const bodies: unknown[] = []
    const m = mockFetch({
      'PUT /api/sites/my-app/secrets/API_KEY': (_u, init) => {
        bodies.push(JSON.parse(String(init.body)))
        return put({ deployed: { versionId: VERSION, url: 'https://my-app.sites.example.test/' } })
      },
    })
    const { ctx, log } = await testContext({ store: await serversStore(), fetch: m.fetch })
    ctx.readStdin = async () => 'secret-value\n'
    await runSecretsSet(ctx, 'my-app', ['API_KEY'], {})
    expect(bodies).toEqual([{ value: 'secret-value' }])
    const text = log.lines.join('\n')
    expect(text).toContain('API_KEY set on my-app')
    expect(text).toContain(`Version ${VERSION} is live now: https://my-app.sites.example.test/`)
    expect(text).not.toContain('secret-value')
  })

  it('never takes a value on the command line', async () => {
    const { ctx } = await testContext({ store: await serversStore() })
    expect((await captureError(runSecretsSet(ctx, 'my-app', ['API_KEY=x'], {}))).message).toMatch(
      /never goes on the command line/
    )
  })

  it('--from sends only the named keys, and prints a start that failed with its log', async () => {
    const dir = await tempDir()
    await writeTree(dir, { '.env': 'API_KEY=k1\nOTHER=nope\n' })
    const sent: string[] = []
    const m = mockFetch({
      'PUT /api/sites/my-app/secrets/API_KEY': (_u, init) => {
        sent.push(String(init.body))
        return put({
          live: {
            versionId: VERSION,
            ok: false,
            error: 'server_failed_to_start',
            message: 'it crashed',
            logs: ['Error: boom'],
          },
        })
      },
    })
    const { ctx, log } = await testContext({ store: await serversStore(), fetch: m.fetch })
    await runSecretsSet(ctx, 'my-app', ['API_KEY'], { from: join(dir, '.env') })
    expect(sent).toEqual(['{"value":"k1"}'])
    expect(log.lines.join('\n')).toMatch(/it crashed[\s\S]*Error: boom/)
    process.exitCode = 0
  })

  it('lists names, who set them and what is missing, never values', async () => {
    const m = mockFetch({
      'GET /api/sites/my-app/secrets': () =>
        jsonResponse({
          secrets: [
            { name: 'API_KEY', setBy: 'ada@example.test', setAt: new Date().toISOString() },
          ],
          declared: ['API_KEY', 'OTHER'],
          missing: ['OTHER'],
        }),
    })
    const { ctx, out } = await testContext({ store: await serversStore(), fetch: m.fetch })
    await runSecretsList(ctx, 'my-app')
    expect(out.content()).toMatch(/API_KEY\s+ada@example\.test\s+just now/)
    expect(out.content()).toContain('not set: OTHER')
  })

  it('says when the Fling does not run site servers', async () => {
    const m = mockFetch({ 'GET /.well-known/fling': () => jsonResponse(INSTANCE) })
    const { ctx } = await testContext({ store: await serversStore(INSTANCE), fetch: m.fetch })
    expect((await captureError(runSecretsList(ctx, 'my-app'))).message).toMatch(
      /doesn't run site servers/
    )
  })
})

describe('fling logs', () => {
  const line = (at: string, text: string) => ({ at, versionId: VERSION, kind: 'output', text })

  it('prints the last hour, and --follow prints each new line once', async () => {
    const answers = [
      [line('2026-11-15T06:00:00.000Z', 'one')],
      [line('2026-11-15T06:00:00.000Z', 'one'), line('2026-11-15T06:00:01.000Z', 'two')],
    ]
    const asked: (string | null)[] = []
    const m = mockFetch({
      'GET /api/sites/my-app/logs': url => {
        asked.push(url.searchParams.get('since'))
        return jsonResponse({ lines: answers.shift() ?? [] })
      },
    })
    const { ctx, out } = await testContext({ store: await serversStore(), fetch: m.fetch })
    await runLogs(ctx, 'my-app', { follow: true, polls: 2, sleep: async () => {} })
    expect(asked).toEqual(['1h', '2026-11-15T06:00:00.000Z', '2026-11-15T06:00:01.000Z'])
    expect(out.content()).toBe('06:00:00  one\n06:00:01  two\n')
  })

  it('refuses a --since it cannot read', async () => {
    const { ctx } = await testContext({ store: await serversStore() })
    expect((await captureError(runLogs(ctx, 'my-app', { since: 'yesterday' }))).message).toMatch(
      /Invalid --since/
    )
  })

  it('newLogLines drops lines already seen', () => {
    const seen = new Set<string>()
    const a = line('t1', 'a') as never
    expect(newLogLines(seen, [a])).toHaveLength(1)
    expect(newLogLines(seen, [a])).toHaveLength(0)
  })
})

describe('fling deploy with a server', () => {
  function deployRoutes(onDeploy: (body: any) => Response) {
    return mockFetch({
      'POST /api/sites/my-app/deploys': (_u, init) => onDeploy(JSON.parse(String(init.body))),
      'PUT /put/bundle': () => new Response(null, { status: 200 }),
      [`POST /api/sites/my-app/deploys/${VERSION}/finalize`]: () =>
        jsonResponse({ status: 'live', versionId: VERSION, site: site({ hasServer: true }) }),
    })
  }
  const upload = () =>
    jsonResponse({
      status: 'upload',
      versionId: VERSION,
      uploads: [{ path: SERVER_BUNDLE, url: 'https://s3.test/put/bundle', headers: {} }],
    })

  it('sends the bundle and fling.json, and says where the server answers', async () => {
    const dir = await serverFolder()
    const bodies: any[] = []
    const m = deployRoutes(body => {
      bodies.push(body)
      return upload()
    })
    const { ctx, out, log } = await testContext({ store: await serversStore(), fetch: m.fetch })
    await runDeploy(ctx, dir, { name: 'my-app' })
    expect(bodies[0].server).toEqual({ secrets: ['API_KEY'], health: '/api/health' })
    expect(bodies[0].manifest.files.map((f: { path: string }) => f.path)).toEqual([
      SERVER_BUNDLE,
      'index.html',
    ])
    expect(bodies[0].confirmPublicServer).toBeUndefined()
    const text = `${log.lines.join('\n')}\n${out.content()}`
    expect(text).toMatch(/bundling server\.ts → _fling\/server\.mjs/)
    expect(text).toMatch(/starting server… GET \/api\/health answered in/)
    expect(text).toContain(
      'server: /api/* · members only · outbound network: open · secrets: API_KEY'
    )
    expect(text).toContain('fling logs my-app')
  })

  it('public_server: refused without a terminal, confirmed up front with --yes', async () => {
    const dir = await serverFolder()
    const refuse = () =>
      jsonResponse(
        {
          error: {
            code: 'public_server',
            message: '"my-app" is public and this version has a server',
          },
        },
        409
      )
    const m = deployRoutes(body => (body.confirmPublicServer ? upload() : refuse()))
    const { ctx } = await testContext({ store: await serversStore(), fetch: m.fetch })
    const error = await captureError(runDeploy(ctx, dir, { name: 'my-app', access: 'public' }))
    expect(error.code).toBe('public_server')
    expect(error.hint).toMatch(/--yes/)
    await runDeploy(ctx, dir, { name: 'my-app', access: 'public', yes: true })

    const asked: string[] = []
    const tty = await testContext({
      store: await serversStore(),
      fetch: m.fetch,
      interactive: true,
      confirm: async q => {
        asked.push(q)
        return true
      },
    })
    await runDeploy(tty.ctx, dir, { name: 'my-app', access: 'public' })
    expect(asked).toHaveLength(1)
  })

  it('secrets_missing: names the secrets and says the version goes live once they are set', async () => {
    const dir = await serverFolder()
    const m = mockFetch({
      'POST /api/sites/my-app/deploys': () => upload(),
      'PUT /put/bundle': () => new Response(null, { status: 200 }),
      [`POST /api/sites/my-app/deploys/${VERSION}/finalize`]: () =>
        jsonResponse(
          {
            error: {
              code: 'secrets_missing',
              message: 'Version x needs API_KEY',
              secrets: ['API_KEY'],
              versionId: VERSION,
            },
          },
          409
        ),
    })
    const { ctx } = await testContext({ store: await serversStore(), fetch: m.fetch })
    const error = await captureError(runDeploy(ctx, dir, { name: 'my-app' }))
    expect(error.code).toBe('secrets_missing')
    expect(error.hint).toContain('fling secrets set my-app --from .env API_KEY')
    expect(error.hint).toMatch(/goes live as soon as/)
  })

  it('server_failed_to_start: the message carries the log, the hint says what to do', async () => {
    const dir = await serverFolder()
    const m = mockFetch({
      'POST /api/sites/my-app/deploys': () => upload(),
      'PUT /put/bundle': () => new Response(null, { status: 200 }),
      [`POST /api/sites/my-app/deploys/${VERSION}/finalize`]: () =>
        jsonResponse(
          {
            error: {
              code: 'server_failed_to_start',
              message: "Not published: the server didn't start. Its log:\nTypeError: x",
              logs: ['TypeError: x'],
            },
          },
          422
        ),
    })
    const { ctx } = await testContext({ store: await serversStore(), fetch: m.fetch })
    const error = await captureError(runDeploy(ctx, dir, { name: 'my-app' }))
    expect(error.message).toContain('TypeError: x')
    expect(error.logs).toEqual(['TypeError: x'])
    expect(error.hint).toMatch(/fling dev/)
  })

  it('refuses a server in a path publish before anything is sent', async () => {
    const dir = await serverFolder()
    const m = mockFetch({})
    const { ctx } = await testContext({
      store: await serversStore({
        ...SERVERS_ON,
        capabilities: { ...SERVERS_ON.capabilities, pathPublish: true },
      }),
      fetch: m.fetch,
    })
    const error = await captureError(runDeploy(ctx, dir, { name: 'my-app', path: 'PAY-1' }))
    expect(error.message).toMatch(/A Path can't have a server/)
    expect(m.calls.filter(c => c.method === 'POST')).toHaveLength(0)
  })
})

describe('MCP wording', () => {
  it('server_failed_to_start returns the log so the agent can fix it', () => {
    const text = describeServerError(
      'server_failed_to_start',
      "Not published: it didn't start. Its log:\nboom",
      { logs: ['boom'] },
      { site: 'my-app', retryWith: 'fling_deploy', local: true }
    )
    expect(text).toMatch(/The server's log:\nboom/)
    expect(text).toMatch(/fling_dev/)
  })

  it('secrets_missing never asks for a value', () => {
    const text = describeServerError(
      'secrets_missing',
      'needs A',
      { secrets: ['A'] },
      {
        site: 'my-app',
        retryWith: 'fling_publish',
      }
    )
    expect(text).toContain('fling secrets set my-app --from .env A')
    expect(text).toMatch(/Never ask for a secret's value/)
  })

  it('fling_server_template is the remote MCP example', async () => {
    const example = join(import.meta.dirname, '../../../examples/site-servers/remote-mcp')
    expect(await readFile(join(example, '_fling/server.mjs'), 'utf8')).toBe(SERVER_TEMPLATE)
    expect(JSON.parse(await readFile(join(example, 'fling.json'), 'utf8'))).toEqual(
      SERVER_TEMPLATE_CONFIG
    )
    expect(unbundledImports(SERVER_TEMPLATE, SERVER_HELPER_MODULE)).toEqual([])
  })
})

describe('fling dev', () => {
  it('serves the folder as the sites host does and runs its server with the viewer and the declared secrets', async () => {
    const root = await tempDir()
    const dir = join(root, 'dev-site')
    await writeTree(dir, {
      'index.html': '<h1>hi</h1>',
      'docs/index.html': 'docs',
      'server.js': [
        "import { viewer, secret } from '" + SERVER_HELPER_MODULE + "'",
        'export default { fetch: r => Response.json({ viewer: viewer(r), key: secret("API_KEY"), other: process.env.OTHER ?? null }) }',
      ].join('\n'),
      'fling.json': '{"secrets":["API_KEY"]}',
      '.env': 'API_KEY=local-key\nOTHER=kept-out\n',
    })
    const dev = await startDevServer({ dir, port: 0, as: 'Ada@Example.test', watch: false })
    try {
      const url = dev.status().url
      const me = await fetch(`${url}/api/me`).then(r => r.json())
      expect(me).toMatchObject({
        viewer: { email: 'ada@example.test', guest: false, id: expect.stringMatching(/^v_/) },
        key: 'local-key',
        other: null,
      })
      expect((await fetch(`${url}/api/me`)).headers.get('cache-control')).toBe('private, no-store')
      expect((await fetch(`${url}/`)).status).toBe(200)
      const docs = await fetch(`${url}/docs`, { redirect: 'manual' })
      expect(docs.status).toBe(301)
      for (const hidden of ['/server.js', '/fling.json', '/.env', `/${SERVER_BUNDLE}`]) {
        expect((await fetch(`${url}${hidden}`)).status).toBe(404)
      }
      const cross = await fetch(`${url}/api/me`, {
        method: 'POST',
        headers: { origin: 'http://elsewhere.test' },
      })
      expect(cross.status).toBe(403)
      expect((await fetch(`${url}/contact`, { method: 'POST' })).status).toBe(405)
      expect(dev.recentLogs().some(l => l.kind === 'request' && l.path === '/api/me')).toBe(true)
    } finally {
      await dev.close()
    }
  })
})

describe('what setting a secret did', () => {
  it('says when nothing is live or waiting, and that a failed version needs deploying again', () => {
    expect(describeSecretOutcome('s', {}).lines[0]).toMatch(/next deploy/)
    expect(describeSecretOutcome('s', {}, true).lines).toEqual([])
    const failed = describeSecretOutcome('s', {
      deployed: { versionId: VERSION, error: 'server_failed_to_start', message: 'no', logs: ['x'] },
    })
    expect(failed).toMatchObject({ failed: true, logs: ['x'] })
    expect(failed.lines.join('\n')).toMatch(/deploy again/)
  })
})
