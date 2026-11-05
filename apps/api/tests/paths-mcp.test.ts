/**
 * The Paths tools on the remote MCP server: fling_paths (with what the home page does),
 * fling_paths_template and fling_paths_check, and `path` on fling_info, fling_files and
 * fling_rollback.
 */
import { PATHS_TEMPLATE_NAMES } from '@fling/shared/paths-templates'
import { beforeEach, describe, expect, it } from 'vitest'
import { type Env, setup } from './helpers.ts'
import { callTool, connect, rpc } from './oauth-helpers.ts'

let env: Env
let bearer: string

beforeEach(async () => {
  env = setup()
  bearer = (await connect(env)).accessToken
})

const page = (title: string, body = '') =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`

async function publish(name: string, files: Record<string, string>, extra: object = {}) {
  const r = await callTool(env, bearer, 'fling_publish', {
    name,
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
    ...extra,
  })
  expect(r.isError).toBeFalsy()
  return r.structuredContent
}

describe('fling_paths', () => {
  it('lists the Paths and says the home page lists them through its block', async () => {
    await publish('team', { 'index.html': page('Team', '<!-- fling:paths -->') })
    await publish('team', { 'index.html': page('Plan 1') }, { path: 'PAY-1' })
    const r = await callTool(env, bearer, 'fling_paths', { name: 'team' })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent.paths).toMatchObject([
      { folder: 'PAY-1', title: 'Plan 1', archived: false, canPublish: true },
    ])
    expect(r.structuredContent.home).toBe('block')
    expect(r.content[0]?.text).toContain('1 Path on team:')
    expect(r.content[0]?.text).toContain('/PAY-1/ "Plan 1"')
    expect(r.content[0]?.text).toMatch(/Home page: the site's index\.html has a Paths block/)
  })

  it('says when the home page has no Paths block, and what to offer', async () => {
    await publish('team', { 'index.html': page('Team') })
    await publish('team', { 'index.html': page('Plan 1') }, { path: 'PAY-1' })
    const r = await callTool(env, bearer, 'fling_paths', { name: 'team' })
    expect(r.structuredContent.home).toBe('own')
    expect(r.content[0]?.text).toMatch(/has no Paths block, so it lists none/)
    expect(r.content[0]?.text).toContain('fling_paths_template')
  })

  it('says a site whose first publish is a Path lists them through its home page’s block', async () => {
    await publish('team', { 'index.html': page('Plan 1') }, { path: 'PAY-1' })
    const r = await callTool(env, bearer, 'fling_paths', { name: 'team' })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent.home).toBe('block')
  })

  it('describes the home page choice in the tool list', async () => {
    const res = await rpc(env, bearer, 'tools/list')
    const body = await res.json()
    const tools = body.result.tools as { name: string; description: string }[]
    for (const name of ['fling_paths', 'fling_paths_template', 'fling_paths_check']) {
      const d = tools.find(t => t.name === name)?.description ?? ''
      expect(d, name).toContain('<!-- fling:paths -->')
      expect(d, name).toContain('paths_index_missing')
    }
  })
})

describe('path on fling_info, fling_files and fling_rollback', () => {
  it('shows the Path, lists its files and rolls back only it', async () => {
    await publish('team', { 'index.html': page('Team', '<!-- fling:paths -->') })
    const first = await publish('team', { 'index.html': page('Plan v1') }, { path: 'PAY-1' })
    const second = await publish('team', { 'index.html': page('Plan v2') }, { path: '/PAY-1/' })
    const siteVersion = (await env.store.findSite('team'))?.currentVersionId

    const info = await callTool(env, bearer, 'fling_info', { name: 'team', path: 'PAY-1' })
    expect(info.isError).toBeFalsy()
    expect(info.structuredContent.versions.map((v: { id: string }) => v.id)).toEqual([
      second.versionId,
      first.versionId,
    ])
    expect(info.content[0]?.text).toContain(`${second.versionId} (current)`)

    const files = await callTool(env, bearer, 'fling_files', {
      name: 'team',
      path: 'PAY-1',
      versionId: first.versionId,
    })
    expect(files.isError).toBeFalsy()
    expect(files.structuredContent).toMatchObject({ path: 'PAY-1', current: false })
    expect(files.content[0]?.text).toContain('team /PAY-1/ version')

    const rolled = await callTool(env, bearer, 'fling_rollback', {
      name: 'team',
      path: 'PAY-1',
      versionId: first.versionId,
    })
    expect(rolled.isError).toBeFalsy()
    expect(rolled.structuredContent.currentVersionId).toBe(first.versionId)
    expect((await env.store.findSite('team'))?.currentVersionId).toBe(siteVersion)
  })

  it('refuses a nested folder, and a Path that isn’t there', async () => {
    await publish('team', { 'index.html': page('Team') })
    const nested = await callTool(env, bearer, 'fling_info', { name: 'team', path: 'a/b' })
    expect(nested.isError).toBe(true)
    expect(nested.content[0]?.text).toMatch(/not a Path/)
    const missing = await callTool(env, bearer, 'fling_info', { name: 'team', path: 'NOPE' })
    expect(missing.isError).toBe(true)
  })
})

describe('fling_paths_template and fling_paths_check', () => {
  it.each(PATHS_TEMPLATE_NAMES)('the %s template passes fling_paths_check', async template => {
    const t = await callTool(env, bearer, 'fling_paths_template', { template, title: 'Plans' })
    expect(t.isError).toBeFalsy()
    const html = t.structuredContent.html as string
    expect(html).toContain('<title>Plans</title>')
    const check = await callTool(env, bearer, 'fling_paths_check', { html })
    expect(check.structuredContent).toMatchObject({ ok: true, errors: [], warnings: [] })
  })

  it('reports a page without a block', async () => {
    const check = await callTool(env, bearer, 'fling_paths_check', { html: page('Team') })
    expect(check.structuredContent.ok).toBe(false)
    expect(check.content[0]?.text).toMatch(/no Paths block/)
  })
})
