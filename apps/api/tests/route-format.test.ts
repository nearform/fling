/**
 * route-format.ts: an admin chooses the route table's format; route writes from then on take it,
 * and maintenance rewrites every site's routes into it until it has done them all. Choosing
 * `json` again rewrites them back, which is what a rollback to an older edge needs.
 */
import { pathKvsKey, shareKvsKey, siteKvsKey } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { maintain } from '../src/maintenance.ts'
import { APP_ORIGIN, api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import { SESSION } from './oauth-helpers.ts'

const BOSS = 'boss@example.test'
const ALICE = 'alice@example.test'

function browser(env: Env, session: string, method: string, path: string, body?: unknown) {
  return env.app.request(path, {
    method,
    headers: {
      cookie: `${SESSION}=${session}`,
      origin: APP_ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function deploy(env: Env, key: string, name: string, extra: { path?: string } = {}) {
  const at = extra.path ? `${extra.path}/index.html` : 'index.html'
  const f = file(at, `<h1>${name} ${extra.path ?? ''}</h1>`)
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: [f.meta] },
    ...extra,
  })
  const body = await json(res)
  if (body.status === 'upload') {
    await upload(env, body.uploads, [f])
    await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
  }
}

async function world() {
  const env = setup({ adminEmails: [BOSS] })
  const boss = await createUser(env, BOSS)
  const alice = await createUser(env, ALICE)
  return { env, boss, alice }
}

const value = (env: Env, key: string) => env.routeTable.data.get(key) ?? ''

describe('the route table format', () => {
  it('is json until an admin chooses; new writes take the choice at once', async () => {
    const { env, boss, alice } = await world()
    const before = await json(await browser(env, boss.session, 'GET', '/api/admin/route-table'))
    expect(before).toEqual({ format: 'json', usage: null })
    await deploy(env, alice.key, 'early')
    expect(value(env, siteKvsKey('early')).startsWith('{')).toBe(true)

    const chose = await browser(env, boss.session, 'POST', '/api/admin/route-table', {
      format: 'compact',
    })
    expect(chose.status).toBe(200)
    expect(await json(chose)).toMatchObject({
      format: 'compact',
      setBy: BOSS,
      rewrite: { after: null, sites: 0 },
    })
    await deploy(env, alice.key, 'later')
    expect(value(env, siteKvsKey('later')).startsWith('~')).toBe(true)
  })

  it('maintenance rewrites every site, share links and Paths, and back again', async () => {
    const { env, boss, alice } = await world()
    await deploy(env, alice.key, 'team')
    await deploy(env, alice.key, 'team', { path: 'PAY-1' })
    expect((await api(env, alice.key, 'POST', '/api/sites/team/share')).status).toBe(200)
    const site = await env.store.findSite('team')
    const keys = [
      siteKvsKey('team'),
      shareKvsKey(site?.shareToken ?? ''),
      pathKvsKey(site?.id ?? '', 'PAY-1'),
    ]
    for (const k of keys) expect(value(env, k).startsWith('{')).toBe(true)

    for (const format of ['compact', 'json'] as const) {
      await browser(env, boss.session, 'POST', '/api/admin/route-table', { format })
      expect((await maintain(env.deps)).routes).toBeGreaterThan(0)
      const status = await json(await browser(env, boss.session, 'GET', '/api/admin/route-table'))
      expect(status.rewrite.finishedAt).toBeDefined()
      if (format === 'compact') {
        expect(value(env, keys[0] as string).startsWith('~')).toBe(true)
        expect(value(env, keys[1] as string)).toBe('>team')
        expect(value(env, keys[2] as string).startsWith('~')).toBe(true)
      } else {
        for (const k of keys) expect(value(env, k).startsWith('{')).toBe(true)
      }
      // Done is done: the next run rewrites nothing.
      expect((await maintain(env.deps)).routes).toBe(0)
    }
  })

  it('is an admin page: read with an admin key, chosen only in a browser session', async () => {
    const { env, boss, alice } = await world()
    expect((await browser(env, alice.session, 'GET', '/api/admin/route-table')).status).toBe(404)
    expect((await api(env, boss.key, 'GET', '/api/admin/route-table')).status).toBe(200)
    const byKey = await api(env, boss.key, 'POST', '/api/admin/route-table', { format: 'compact' })
    expect(byKey.status).toBe(404)
    const bad = await browser(env, boss.session, 'POST', '/api/admin/route-table', {
      format: 'xml',
    })
    expect(bad.status).toBe(400)
  })
})
