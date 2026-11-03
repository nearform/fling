/**
 * Forms in the CLI: `deploy` takes fling.forms.json out of the manifest, checks it and sends it as
 * `forms` (or `null` / nothing without one), with the summary or the one-line hint (`--quiet`);
 * `pull` writes it back; `forms init`, `forms check`, `forms <name>` and `responses`; and the local
 * MCP's forms tools, gated on the `forms` capability.
 */
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FORMS_FILE,
  formsTemplate,
  type InstanceMetadata,
  type ResponsesExport,
} from '@fling/shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/api.ts'
import { runDeploy } from '../src/commands/deploy.ts'
import { runForms, runFormsCheck, runFormsInit, runResponses } from '../src/commands/forms.ts'
import { runPull } from '../src/commands/pull.ts'
import type { ConfigStore } from '../src/config.ts'
import { createMcpServer } from '../src/mcp.ts'
import { readSiteLink } from '../src/pull.ts'
import {
  captureError,
  INSTANCE,
  jsonResponse,
  mockFetch,
  type Route,
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

const FORMS_INSTANCE: InstanceMetadata = {
  ...INSTANCE,
  capabilities: { ...INSTANCE.capabilities, comments: true, forms: true, pull: true },
}
const VERSION = '0123456789abcdef'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

async function storeWith(instance: InstanceMetadata = FORMS_INSTANCE) {
  const { store } = await tempStore()
  await store.putServer(SERVER, { instance, apiKey: TEST_KEY })
  return store
}

const labels = () => {
  const config = formsTemplate('labels')
  return { ...config, forms: config.forms.map(f => ({ ...f, paths: ['interviews/**'] })) }
}

async function folder(files: Record<string, string> = {}) {
  const dir = join(await tempDir(), 'my-app')
  await writeTree(dir, {
    'index.html': '<h1>home</h1>',
    'interviews/1.html': '<h1>one</h1>',
    'interviews/2.html': '<h1>two</h1>',
    ...files,
  })
  return dir
}

/** A deploy route answering `unchanged`, recording each request's body. */
function deployRoutes(extra: Record<string, Route> = {}) {
  const bodies: Record<string, unknown>[] = []
  const m = mockFetch({
    'GET /.well-known/fling': () => jsonResponse(FORMS_INSTANCE),
    'POST /api/sites/my-app/deploys': (_url, init) => {
      bodies.push(JSON.parse(String(init.body)))
      return jsonResponse({ status: 'unchanged', versionId: VERSION, site: site() })
    },
    ...extra,
  })
  return { ...m, bodies }
}

const paths = (body: Record<string, unknown> | undefined) =>
  ((body?.manifest as { files: { path: string }[] } | undefined)?.files ?? [])
    .map(f => f.path)
    .sort()

describe('deploy with forms', () => {
  it('takes fling.forms.json out of the manifest, sends it and lists the forms', async () => {
    const dir = await folder({ [FORMS_FILE]: JSON.stringify(labels()) })
    const m = deployRoutes()
    const { ctx, log } = await testContext({ store: await storeWith(), fetch: m.fetch })
    await runDeploy(ctx, dir, {})
    expect(paths(m.bodies[0])).toEqual(['index.html', 'interviews/1.html', 'interviews/2.html'])
    expect(m.bodies[0]?.forms).toEqual(labels())
    const said = log.lines.join('\n')
    expect(said).toContain('Labels · Label this page (label): one per reviewer per page, 2 pages')
    expect(said).toContain(`Responses and progress: ${SERVER}/sites/my-app/responses`)
    expect(said).not.toContain('fling forms init')

    const json = await testContext({ store: await storeWith(), fetch: m.fetch, json: true })
    await runDeploy(json.ctx, dir, {})
    const data = JSON.parse(json.out.content())
    expect(data.forms).toMatchObject({
      title: 'Labels',
      responsesUrl: `${SERVER}/sites/my-app/responses`,
    })
    expect(data.forms.forms[0].pages).toEqual(['/interviews/1.html', '/interviews/2.html'])
    expect(data.formsHint).toBeUndefined()
  })

  it('stops on a config that is not valid, saying where, before anything is sent', async () => {
    const dir = await folder({ [FORMS_FILE]: JSON.stringify({ forms: [] }) })
    const m = deployRoutes()
    const { ctx } = await testContext({ store: await storeWith(), fetch: m.fetch })
    const error = await captureError(runDeploy(ctx, dir, {}))
    expect(error.message).toMatch(/fling.forms.json is not a forms config.*\n {2}title/s)
    expect(m.bodies).toEqual([])

    await writeTree(dir, { [FORMS_FILE]: '{ nope' })
    expect((await captureError(runDeploy(ctx, dir, {}))).message).toMatch(/not valid JSON/)
  })

  it('without the file, a whole-site deploy sends null and ends with the hint; --quiet hides it', async () => {
    const dir = await folder()
    const m = deployRoutes()
    const { ctx, log } = await testContext({ store: await storeWith(), fetch: m.fetch })
    await runDeploy(ctx, dir, {})
    expect(m.bodies[0]?.forms).toBeNull()
    const hints = log.lines.filter(l => l.includes('fling forms init'))
    expect(hints).toHaveLength(1)

    const quiet = await testContext({ store: await storeWith(), fetch: m.fetch })
    await runDeploy(quiet.ctx, dir, { quiet: true })
    expect(quiet.log.lines.join('\n')).not.toContain('fling forms init')

    const json = await testContext({ store: await storeWith(), fetch: m.fetch, json: true })
    await runDeploy(json.ctx, dir, { quiet: true })
    expect(JSON.parse(json.out.content()).formsHint).toMatch(/fling forms init/)
  })

  it('a path publish without the file sends nothing, keeping the site’s forms', async () => {
    const dir = await folder()
    const m = deployRoutes({
      'GET /api/sites/my-app/forms': () =>
        jsonResponse({ versionId: VERSION, config: labels(), forms: labels().forms }),
    })
    const instance = {
      ...FORMS_INSTANCE,
      capabilities: { ...FORMS_INSTANCE.capabilities, pathPublish: true },
    }
    const { ctx, log } = await testContext({ store: await storeWith(instance), fetch: m.fetch })
    await runDeploy(ctx, dir, { name: 'my-app', path: 'week' })
    expect(m.bodies[0]).not.toHaveProperty('forms')
    expect(log.lines.join('\n')).toContain('Labels · Label this page (label)')
  })

  it('a Fling without forms: no forms sent, no hint, and a forms file is refused', async () => {
    const dir = await folder()
    const m = mockFetch({
      'GET /.well-known/fling': () => jsonResponse(INSTANCE),
      'POST /api/sites/my-app/deploys': (_url, init) => {
        expect(JSON.parse(String(init.body))).not.toHaveProperty('forms')
        return jsonResponse({ status: 'unchanged', versionId: VERSION, site: site() })
      },
    })
    const { ctx, log } = await testContext({ store: await storeWith(INSTANCE), fetch: m.fetch })
    await runDeploy(ctx, dir, {})
    expect(log.lines.join('\n')).not.toContain('forms init')

    await writeTree(dir, { [FORMS_FILE]: JSON.stringify(labels()) })
    expect((await captureError(runDeploy(ctx, dir, {}))).message).toMatch(/has no forms/)
  })
})

describe('pull and forms', () => {
  const page = '<h1>v1</h1>'
  const routes = (bodies: Record<string, unknown>[]) =>
    mockFetch({
      'GET /.well-known/fling': () => jsonResponse(FORMS_INSTANCE),
      'GET /api/sites/my-app/pull': () =>
        jsonResponse({
          versionId: VERSION,
          expiresAt: '2026-11-01T00:15:00.000Z',
          files: [
            {
              path: 'index.html',
              size: page.length,
              contentType: 'text/html',
              sha256: sha(page),
              url: `${SERVER}/blob/index.html`,
            },
          ],
          forms: labels(),
        }),
      'GET /blob/index.html': () => new Response(page),
      'POST /api/sites/my-app/deploys': (_url, init) => {
        bodies.push(JSON.parse(String(init.body)))
        return jsonResponse({ status: 'unchanged', versionId: VERSION, site: site() })
      },
    })

  it('writes fling.forms.json beside the files; deleting it then deploying removes the forms', async () => {
    const bodies: Record<string, unknown>[] = []
    const m = routes(bodies)
    const dir = join(await tempDir(), 'my-app')
    const { ctx } = await testContext({ store: await storeWith(), fetch: m.fetch })
    await runPull(ctx, 'my-app', dir, {})
    const written = await readFile(join(dir, FORMS_FILE), 'utf8')
    expect(JSON.parse(written)).toEqual(labels())
    const link = await readSiteLink(dir)
    expect(link?.forms).toBe(sha(written))
    expect(Object.keys(link?.files ?? {})).toEqual(['index.html'])

    // Deployed as pulled: the file is the forms, on the base, never a file of the site.
    await runDeploy(ctx, dir, {})
    expect(bodies[0]?.base).toBe(VERSION)
    expect(paths(bodies[0])).toEqual(['index.html'])
    expect(bodies[0]?.forms).toEqual(labels())

    await rm(join(dir, FORMS_FILE))
    await runDeploy(ctx, dir, {})
    expect(bodies[1]?.forms).toBeNull()
    expect((await readSiteLink(dir))?.forms).toBeUndefined()
    // …and the next deploy on that base leaves the (now absent) forms alone.
    await runDeploy(ctx, dir, {})
    expect(bodies[2]).not.toHaveProperty('forms')
  })
})

describe('fling forms init and check', () => {
  it('init writes a template that check accepts; it never overwrites without --force', async () => {
    const dir = await folder()
    const { ctx, log } = await testContext({ store: await storeWith() })
    await runFormsInit(ctx, dir, { template: 'rubric', title: 'Scores' })
    const written = JSON.parse(await readFile(join(dir, FORMS_FILE), 'utf8'))
    expect(written.title).toBe('Scores')
    expect((await captureError(runFormsInit(ctx, dir, {}))).message).toMatch(/already exists/)
    await runFormsInit(ctx, dir, { template: 'labels', force: true })
    expect(JSON.parse(await readFile(join(dir, FORMS_FILE), 'utf8')).title).toBe('Labels')
    expect((await captureError(runFormsInit(ctx, dir, { template: 'nope' }))).message).toMatch(
      /Unknown template/
    )

    const checked = await testContext({ store: await storeWith(), json: true })
    await runFormsCheck(checked.ctx, dir)
    const check = JSON.parse(checked.out.content())
    expect(check.ok).toBe(true)
    expect(check.summary.forms[0].pages).toEqual(['/', '/interviews/1.html', '/interviews/2.html'])
    expect(log.lines.join('\n')).toMatch(/Wrote .*fling\.forms\.json/)
  })

  it('check lists every error, and warns about a glob that matches no page', async () => {
    const dir = await folder()
    const bad = { ...labels(), forms: labels().forms.map(f => ({ ...f, paths: ['reports/**'] })) }
    await writeTree(dir, { [FORMS_FILE]: JSON.stringify(bad) })
    const { ctx, out } = await testContext({ store: await storeWith() })
    await runFormsCheck(ctx, dir)
    expect(out.content()).toContain('warning: label: "reports/**" matches no page')

    await writeTree(dir, { [FORMS_FILE]: JSON.stringify({ title: 'x', forms: [{ id: 'a' }] }) })
    expect((await captureError(runFormsCheck(ctx, dir))).message).toMatch(/forms\.0\.title/)
    expect((await captureError(runFormsCheck(ctx, join(dir, 'nothing')))).message).toMatch(
      /No such file/
    )
  })
})

const EXPORT: ResponsesExport = {
  site: { name: 'my-app', currentVersionId: VERSION },
  title: 'Labels',
  forms: labels().forms,
  responses: [
    {
      id: 'R1',
      path: '/interviews/1.html',
      formId: 'label',
      author: 'bob@example.test',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      versionId: VERSION,
      data: { verdict: 'pass', notes: 'fine, "really"' },
    },
  ],
  progress: [
    {
      form: 'label',
      pages: ['/interviews/1.html', '/interviews/2.html'],
      reviewers: ['bob@example.test'],
      done: { '/interviews/1.html': ['bob@example.test'] },
    },
  ],
}

describe('fling forms <name> and fling responses', () => {
  const routes = () =>
    mockFetch({
      'GET /.well-known/fling': () => jsonResponse(FORMS_INSTANCE),
      'GET /api/sites/my-app/forms': () =>
        jsonResponse({ versionId: VERSION, config: labels(), forms: labels().forms }),
      'GET /api/sites/my-app/responses': () => jsonResponse(EXPORT),
    })

  it('forms prints the config on stdout and a line per form', async () => {
    const { ctx, out, log } = await testContext({ store: await storeWith(), fetch: routes().fetch })
    await runForms(ctx, 'my-app', {})
    expect(JSON.parse(out.content())).toEqual(labels())
    expect(log.lines.join('\n')).toContain('Label this page (label)')
  })

  it('responses: a table with progress, or the export as csv, jsonl or json', async () => {
    const m = routes()
    const human = await testContext({ store: await storeWith(), fetch: m.fetch })
    await runResponses(human.ctx, 'my-app', {})
    const table = human.out.content()
    expect(table).toContain('Verdict: Pass: it does what it should')
    expect(table).toContain('Label this page (label): 1 / 2 pages answered, 1 reviewer')
    expect(m.calls.at(-1)?.url.searchParams.get('format')).toBe('json')

    const csv = await testContext({ store: await storeWith(), fetch: m.fetch })
    await runResponses(csv.ctx, 'my-app', { format: 'csv' })
    expect(csv.out.content()).toMatch(
      /^id,path,formId,author,createdAt,updatedAt,versionId,verdict,notes\r\n/
    )
    expect(csv.out.content()).toContain('"fine, ""really"""')

    const jsonl = await testContext({ store: await storeWith(), fetch: m.fetch })
    await runResponses(jsonl.ctx, 'my-app', { format: 'jsonl' })
    expect(JSON.parse(jsonl.out.content().trim())).toMatchObject({ id: 'R1' })

    const file = join(await tempDir(), 'out.json')
    const saved = await testContext({ store: await storeWith(), fetch: m.fetch })
    await runResponses(saved.ctx, 'my-app', { output: file })
    expect(JSON.parse(await readFile(file, 'utf8')).responses).toHaveLength(1)

    expect(
      (await captureError(runResponses(saved.ctx, 'my-app', { format: 'xml' }))).message
    ).toMatch(/json, jsonl or csv/)
  })

  it('refuses on a Fling without forms', async () => {
    const m = mockFetch({ 'GET /.well-known/fling': () => jsonResponse(INSTANCE) })
    const { ctx } = await testContext({ store: await storeWith(INSTANCE), fetch: m.fetch })
    expect((await captureError(runResponses(ctx, 'my-app', {}))).message).toMatch(/has no forms/)
  })
})

describe('the local MCP forms tools', () => {
  async function connect(store: ConfigStore, fetchImpl: FetchLike, instance = FORMS_INSTANCE) {
    const home = await tempDir()
    const server = createMcpServer({
      store,
      fetch: fetchImpl,
      locate: { cwd: home, home, platform: process.platform, env: {} },
      waitReady: async () => ({ ready: true, waitedMs: 0 }),
      servers: [{ url: SERVER, instance, current: true, signedIn: true }],
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const mcp = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([server.connect(serverT), mcp.connect(clientT)])
    return mcp
  }
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? ''
  const dataOf = (r: unknown) => JSON.parse(text(r).slice(text(r).indexOf('\n\n') + 2))

  it('a template passes fling_forms_check', async () => {
    const mcp = await connect(await storeWith(), mockFetch({}).fetch)
    const t = await mcp.callTool({
      name: 'fling_forms_template',
      arguments: { template: 'compare', title: 'Prefs' },
    })
    const config = dataOf(t)
    expect(config.title).toBe('Prefs')
    const check = await mcp.callTool({
      name: 'fling_forms_check',
      arguments: { forms: config, paths: ['index.html', 'a.html'] },
    })
    expect(dataOf(check).ok).toBe(true)
    expect(text(check)).toContain('2 pages')
  })

  it('fling_publish carries the hint without forms, and the summary with them', async () => {
    const m = deployRoutes()
    const mcp = await connect(await storeWith(), m.fetch)
    const files = [{ path: 'index.html', content: '<h1>hi</h1>' }]
    const plain = await mcp.callTool({
      name: 'fling_publish',
      arguments: { name: 'my-app', files },
    })
    expect(dataOf(plain).formsHint).toMatch(/fling_forms_template/)
    expect(m.bodies[0]?.forms).toBeNull()

    const withForms = await mcp.callTool({
      name: 'fling_publish',
      arguments: { name: 'my-app', files, forms: formsTemplate('labels') },
    })
    expect(withForms.isError).toBeFalsy()
    expect(m.bodies[1]?.forms).toEqual(formsTemplate('labels'))
    expect(dataOf(withForms).forms).toMatchObject({
      title: 'Labels',
      responsesUrl: `${SERVER}/sites/my-app/responses`,
    })
    expect(text(withForms)).toContain('answer its forms')

    // As a file among the files: the forms, never a file of the site.
    await mcp.callTool({
      name: 'fling_publish',
      arguments: {
        name: 'my-app',
        files: [...files, { path: FORMS_FILE, content: JSON.stringify(formsTemplate('issue')) }],
      },
    })
    expect(paths(m.bodies[2])).toEqual(['index.html'])
    expect(m.bodies[2]?.forms).toEqual(formsTemplate('issue'))

    const bad = await mcp.callTool({
      name: 'fling_publish',
      arguments: { name: 'my-app', files, forms: { title: 'x' } },
    })
    expect(bad.isError).toBe(true)
    expect(text(bad)).toMatch(/not a forms config/)
    expect(m.bodies).toHaveLength(3)
  })

  it('fling_response_submit posts a response; fling_responses_list shows progress', async () => {
    let posted: unknown
    const m = mockFetch({
      'GET /.well-known/fling': () => jsonResponse(FORMS_INSTANCE),
      'POST /api/sites/my-app/comments': (_url, init) => {
        posted = JSON.parse(String(init.body))
        return jsonResponse(
          {
            id: 'R1',
            parentId: null,
            path: '/interviews/1.html',
            versionId: VERSION,
            anchor: null,
            body: 'Label this page\nVerdict: Pass',
            author: { kind: 'user', email: 'a@example.test' },
            createdAt: '2026-11-01T10:00:00.000Z',
            resolvedAt: null,
            resolvedBy: null,
            canDelete: true,
            response: { formId: 'label', data: { verdict: 'pass' }, versionId: VERSION },
          },
          201
        )
      },
      'GET /api/sites/my-app/responses': () => jsonResponse(EXPORT),
    })
    const mcp = await connect(await storeWith(), m.fetch)
    const sent = await mcp.callTool({
      name: 'fling_response_submit',
      arguments: {
        name: 'my-app',
        path: '/interviews/1.html',
        formId: 'label',
        data: { verdict: 'pass' },
      },
    })
    expect(sent.isError).toBeFalsy()
    expect(posted).toEqual({
      path: '/interviews/1.html',
      response: { formId: 'label', data: { verdict: 'pass' } },
    })
    expect(text(sent)).toContain('Verdict: Pass')

    const listed = await mcp.callTool({
      name: 'fling_responses_list',
      arguments: { name: 'my-app' },
    })
    expect(text(listed)).toContain('Label this page (label): 1 / 2 pages answered, 1 reviewer')
    expect(dataOf(listed).responses).toHaveLength(1)
  })

  it('a Fling without forms is offered no forms tools', async () => {
    const mcp = await connect(await storeWith(INSTANCE), mockFetch({}).fetch, INSTANCE)
    const names = (await mcp.listTools()).tools.map(t => t.name)
    expect(names.filter(n => n.includes('forms') || n.includes('response'))).toEqual([])
    expect(names).toContain('fling_publish')
  })
})
