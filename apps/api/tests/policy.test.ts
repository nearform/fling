/**
 * policy.ts: the whole actor × action × visibility table, written out, so changing who may do
 * what means changing this file. Then the two places that enforce it: the edge (site.view, run
 * through the real site router) and every site route and MCP tool (a member gets exactly what a
 * stranger to the name gets).
 */

import { createSiteRouter, isResponse, toCloudFrontEvent } from '@fling/edge'
import { SITE_HMAC_KVS_KEY, siteKvsKey } from '@fling/shared'
import { signSiteCookie } from '@fling/shared/site-cookie'
import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  type Action,
  type Actor,
  can,
  type PolicySite,
  ROLES,
  type Role,
  roleOf,
} from '../src/policy.ts'
import { api, createUser, file, json, setup, upload } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

const OWNER = 'owner@example.test'
const TOKEN = 'abcdefghij0123456789'

const siteWith = (visibility: 'public' | 'private'): PolicySite => ({
  email: OWNER,
  visibility,
  shareToken: TOKEN,
})

const actorFor: Record<Role, Actor> = {
  owner: { kind: 'user', email: OWNER },
  member: { kind: 'user', email: 'member@example.test' },
  share: { kind: 'share', token: TOKEN },
  anonymous: { kind: 'anonymous' },
}

/** Allowed roles per action and visibility: o(wner) m(ember) s(hare) a(nonymous). */
const EXPECTED: Record<Action, { public: string; private: string }> = {
  'site.view': { public: 'omsa', private: 'oms' },
  'site.read': { public: 'o', private: 'o' },
  'version.list': { public: 'o', private: 'o' },
  'version.read': { public: 'o', private: 'o' },
  'site.deploy': { public: 'o', private: 'o' },
  'site.rollback': { public: 'o', private: 'o' },
  'site.settings': { public: 'o', private: 'o' },
  'site.visibility': { public: 'o', private: 'o' },
  'site.archive': { public: 'o', private: 'o' },
  'site.delete': { public: 'o', private: 'o' },
  'share.read': { public: 'o', private: 'o' },
  'share.create': { public: 'o', private: 'o' },
  'share.revoke': { public: 'o', private: 'o' },
}

describe('can', () => {
  it('covers every action', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ACTIONS].sort())
  })

  for (const action of ACTIONS) {
    for (const visibility of ['public', 'private'] as const) {
      for (const role of ROLES) {
        const allowed = EXPECTED[action][visibility].includes(role[0] as string)
        it(`${role} ${allowed ? 'may' : 'may not'} ${action} a ${visibility} site`, () => {
          expect(can(actorFor[role], action, siteWith(visibility))).toBe(allowed)
        })
      }
    }
  }
})

describe('roleOf', () => {
  const site = siteWith('private')

  it('owner is the user holding the site; any other user is a member', () => {
    expect(roleOf(actorFor.owner, site)).toBe('owner')
    expect(roleOf(actorFor.member, site)).toBe('member')
  })

  it("only the site's current share token makes a share actor", () => {
    expect(roleOf({ kind: 'share', token: TOKEN }, site)).toBe('share')
    expect(roleOf({ kind: 'share', token: 'zyxwvutsrq9876543210' }, site)).toBe('anonymous')
    expect(roleOf({ kind: 'share', token: TOKEN }, { ...site, shareToken: null })).toBe('anonymous')
  })
})

const page = [file('index.html', '<h1>hi</h1>')]

/** Deploy `name` live as the env's user with the given key. */
async function deploy(env: ReturnType<typeof setup>, key: string, name: string, extra = {}) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: page.map(f => f.meta) },
    ...extra,
  })
  const body = await json(res)
  if (body.status !== 'upload') return body
  await upload(env, body.uploads, page)
  return json(await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`))
}

describe('the edge agrees with site.view', () => {
  it('for every role and visibility', async () => {
    const env = setup()
    const owner = await createUser(env, 'alice@nearform.com')
    await deploy(env, owner.key, 'pub', { visibility: 'public' })
    await deploy(env, owner.key, 'priv', { visibility: 'private' })
    // The platform entry (lambda.ts, dev.ts) puts the cookie key where the edge reads it.
    await env.routeTable.put(SITE_HMAC_KVS_KEY, env.config.secrets.siteHmacKey)
    const now = env.deps.clock.now().getTime()
    const router = createSiteRouter({
      kvs: env.routeTable,
      appOrigin: env.config.appOrigin,
      now: () => now,
    })
    const cookie = (email: string) =>
      `fling_site=${signSiteCookie({ e: email, x: Math.floor(now / 1000) + 60 }, env.config.secrets.siteHmacKey)}`

    for (const name of ['pub', 'priv']) {
      const share = await json(await api(env, owner.key, 'POST', `/api/sites/${name}/share`))
      const shareHost = new URL(share.shareUrl).host
      const site = (await env.store.findSite(name)) as PolicySite
      const requests: Record<Role, Parameters<typeof toCloudFrontEvent>[0]> = {
        owner: { host: `${name}.fling.test`, cookieHeader: cookie('alice@nearform.com') },
        member: { host: `${name}.fling.test`, cookieHeader: cookie('bob@nearform.com') },
        share: { host: shareHost },
        anonymous: { host: `${name}.fling.test` },
      }
      const actors: Record<Role, Actor> = {
        owner: { kind: 'user', email: 'alice@nearform.com' },
        member: { kind: 'user', email: 'bob@nearform.com' },
        share: { kind: 'share', token: shareHost.split('.')[0]?.slice(3) ?? '' },
        anonymous: { kind: 'anonymous' },
      }
      expect(env.routeTable.data.has(siteKvsKey(name))).toBe(true)
      for (const role of ROLES) {
        const result = await router(toCloudFrontEvent({ path: '/', ...requests[role] }))
        const served = !isResponse(result) && result.uri.startsWith('/sites/')
        expect({ name, role, served }).toEqual({
          name,
          role,
          served: can(actors[role], 'site.view', site),
        })
      }
    }
  })
})

describe("a member can't act on another user's site", () => {
  async function twoUsers() {
    const env = setup()
    const alice = await createUser(env, 'alice@nearform.com')
    const bob = await createUser(env, 'bob@nearform.com')
    const live = await deploy(env, alice.key, 'hello', { visibility: 'public' })
    await api(env, alice.key, 'POST', '/api/sites/hello/share')
    const before = {
      detail: await json(await api(env, alice.key, 'GET', '/api/sites/hello')),
      routes: [...env.routeTable.data.entries()],
    }
    return { env, alice, bob, versionId: live.versionId as string, before }
  }

  it('through the API: 404 like an unknown site, 409 name_taken to deploy; nothing changes', async () => {
    const { env, alice, bob, versionId, before } = await twoUsers()
    const routes: [string, string, object?][] = [
      ['GET', '/api/sites/hello'],
      ['GET', `/api/sites/hello/versions/${versionId}/files`],
      ['PATCH', '/api/sites/hello', { visibility: 'private' }],
      ['PATCH', '/api/sites/hello', { spa: true }],
      ['POST', `/api/sites/hello/deploys/${versionId}/finalize`],
      ['POST', '/api/sites/hello/current', { versionId }],
      ['POST', '/api/sites/hello/share'],
      ['DELETE', '/api/sites/hello/share'],
      ['POST', '/api/sites/hello/archive'],
      ['POST', '/api/sites/hello/unarchive'],
      ['DELETE', '/api/sites/hello'],
    ]
    for (const [method, path, body] of routes) {
      const res = await api(env, bob.key, method, path, body)
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 })
      expect((await json(res)).error.message).toBe('No site named "hello"')
    }
    const deploy = await api(env, bob.key, 'POST', '/api/sites/hello/deploys', {
      manifest: { files: page.map(f => f.meta) },
    })
    expect(deploy.status).toBe(409)
    expect((await json(deploy)).error.code).toBe('name_taken')
    expect((await json(await api(env, bob.key, 'GET', '/api/names/hello'))).status).toBe('taken')
    expect((await json(await api(env, bob.key, 'GET', '/api/sites'))).sites).toEqual([])

    expect(await json(await api(env, alice.key, 'GET', '/api/sites/hello'))).toEqual(before.detail)
    expect([...env.routeTable.data.entries()]).toEqual(before.routes)
  })

  it('through MCP: the same refusals', async () => {
    const { env, alice, versionId, before } = await twoUsers()
    const { accessToken } = await connect(env, 'bob@nearform.com')
    const calls: [string, object][] = [
      ['fling_info', { name: 'hello' }],
      ['fling_files', { name: 'hello' }],
      ['fling_share', { name: 'hello' }],
      ['fling_share', { name: 'hello', refresh: true }],
      ['fling_share', { name: 'hello', revoke: true }],
      ['fling_set_visibility', { name: 'hello', visibility: 'private' }],
      ['fling_archive', { name: 'hello' }],
      ['fling_archive', { name: 'hello', unarchive: true }],
      ['fling_rollback', { name: 'hello', versionId }],
      ['fling_delete', { name: 'hello', confirm: true }],
    ]
    for (const [tool, args] of calls) {
      const r = await callTool(env, accessToken, tool, args)
      expect({ tool, args, isError: r.isError, text: r.content[0]?.text }).toEqual({
        tool,
        args,
        isError: true,
        text: 'No site named "hello"',
      })
    }
    const pub = await callTool(env, accessToken, 'fling_publish', {
      name: 'hello',
      files: [{ path: 'index.html', content: '<h1>mine</h1>' }],
    })
    expect(pub.isError).toBe(true)
    expect(pub.content[0]?.text).toMatch(/already taken by someone else/)
    const check = await callTool(env, accessToken, 'fling_check_name', { name: 'hello' })
    expect(check.structuredContent.status).toBe('taken')

    expect(await json(await api(env, alice.key, 'GET', '/api/sites/hello'))).toEqual(before.detail)
    expect([...env.routeTable.data.entries()]).toEqual(before.routes)
  })

  it("a stale record of the name can't delete the current owner's route", async () => {
    const env = setup()
    const alice = await createUser(env, 'alice@nearform.com')
    const bob = await createUser(env, 'bob@nearform.com')
    await deploy(env, bob.key, 'hello')
    // Alice's old site record for the name, left behind while Bob holds the claim.
    await env.table.put({
      pk: 'USER#alice@nearform.com',
      sk: 'SITE#hello',
      type: 'site',
      id: 'stale',
      email: 'alice@nearform.com',
      name: 'hello',
      visibility: 'public',
      spa: false,
      archived: false,
      currentVersionId: 'old',
      shareToken: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    })
    const route = env.routeTable.data.get(siteKvsKey('hello'))
    expect(route).toBeDefined()
    expect((await api(env, alice.key, 'DELETE', '/api/sites/hello')).status).toBe(404)
    expect((await api(env, alice.key, 'GET', '/api/sites/hello')).status).toBe(404)
    expect(env.routeTable.data.get(siteKvsKey('hello'))).toBe(route)
    expect((await json(await api(env, bob.key, 'GET', '/api/sites/hello'))).name).toBe('hello')
  })
})
