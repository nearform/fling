/**
 * policy.ts: the whole actor × action × access table, written out, so changing who may do what
 * means changing this file. Then the two places that enforce it: the edge (site.view, run through
 * the real site router, with the site pass for restricted sites) and every site route and MCP tool
 * (a member gets exactly what a stranger to the name gets).
 */

import { createSiteRouter, isResponse, toCloudFrontEvent } from '@fling/edge'
import { SITE_HMAC_KVS_KEY, siteKvsKey } from '@fling/shared'
import { signSiteCookie, signSitePass } from '@fling/shared/site-cookie'
import { describe, expect, it } from 'vitest'
import {
  ACCESSES,
  ACTIONS,
  type Access,
  type Action,
  type Actor,
  can,
  canDeleteComment,
  canGroup,
  canInstance,
  GROUP_ACTIONS,
  type GroupAction,
  INSTANCE_ACTIONS,
  type InstanceAction,
  impersonationRefusal,
  type PolicySite,
  PRINCIPAL_ROLES,
  type Principal,
  type PrincipalRole,
  principalRole,
  ROLES,
  type Role,
  roleOf,
} from '../src/policy.ts'
import { api, cookiesOf, createUser, file, json, setup, upload } from './helpers.ts'
import { callTool, connect } from './oauth-helpers.ts'

const OWNER = 'owner@example.test'
const VIEWER = 'viewer@example.test'
const TOKEN = 'abcdefghij0123456789'

/**
 * A site with each access. The audience names the viewer on the public and restricted ones (kept,
 * and ignored, while public); a private site without one has no viewers, so they are a member.
 */
const siteWith = (access: Access): PolicySite => ({
  email: OWNER,
  visibility: access === 'public' ? 'public' : 'private',
  shareToken: TOKEN,
  audience: { emails: access === 'private' ? [] : [VIEWER], groups: [] },
})

const actorFor: Record<Role, Actor> = {
  owner: { kind: 'user', email: OWNER },
  viewer: { kind: 'user', email: VIEWER },
  member: { kind: 'user', email: 'member@example.test' },
  share: { kind: 'share', token: TOKEN },
  anonymous: { kind: 'anonymous' },
}

const ownerOnly = { public: 'o', private: 'o', restricted: 'o' }
const takesPart = { public: 'ovm', private: 'ovm', restricted: 'ov' }

/** Allowed roles per action and access: o(wner) v(iewer) m(ember) s(hare) a(nonymous). */
const EXPECTED: Record<Action, Record<Access, string>> = {
  'site.view': { public: 'ovmsa', private: 'ovms', restricted: 'ovs' },
  'site.read': ownerOnly,
  'version.list': ownerOnly,
  'version.read': ownerOnly,
  'site.deploy': ownerOnly,
  'site.rollback': ownerOnly,
  'site.settings': ownerOnly,
  'site.visibility': ownerOnly,
  'site.audience': ownerOnly,
  'site.archive': ownerOnly,
  'site.delete': ownerOnly,
  'share.read': ownerOnly,
  'share.create': ownerOnly,
  'share.revoke': ownerOnly,
  'comment.read': takesPart,
  'comment.create': takesPart,
  'comment.resolve': takesPart,
  'comment.delete': ownerOnly,
  'comment.delete.own': takesPart,
}

describe('can', () => {
  it('covers every action', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ACTIONS].sort())
  })

  for (const action of ACTIONS) {
    for (const access of ACCESSES) {
      for (const role of ROLES) {
        const allowed = EXPECTED[action][access].includes(role[0] as string)
        it(`${role} ${allowed ? 'may' : 'may not'} ${action} a ${access} site`, () => {
          expect(can(actorFor[role], action, siteWith(access))).toBe(allowed)
        })
      }
    }
  }

  it("a group in the audience makes its members viewers, once requireSite loads the user's groups", () => {
    const site: PolicySite = { ...siteWith('restricted'), audience: { emails: [], groups: ['g1'] } }
    const user = 'member@example.test'
    expect(roleOf({ kind: 'user', email: user }, site)).toBe('member')
    expect(roleOf({ kind: 'user', email: user, groups: ['g2'] }, site)).toBe('member')
    expect(roleOf({ kind: 'user', email: user, groups: ['g1'] }, site)).toBe('viewer')
    expect(can({ kind: 'user', email: user, groups: ['g1'] }, 'site.view', site)).toBe(true)
  })
})

/** Allowed principal roles per instance action: a(dmin) t(oken: an admin's key) i(mpersonating) u(ser). */
const INSTANCE_EXPECTED: Record<InstanceAction, string> = {
  'admin.users.list': 'at',
  'admin.audit.read': 'at',
  'admin.impersonate': 'a',
  'admin.impersonate.stop': 'i',
  'account.key.create': 'atu',
  'account.oauth.approve': 'atu',
  'account.revoke': 'atu',
}

const ROLE_LETTER: Record<PrincipalRole, string> = {
  admin: 'a',
  'admin-token': 't',
  impersonating: 'i',
  user: 'u',
}

const principalFor: Record<PrincipalRole, Principal> = {
  admin: { email: 'boss@example.test', admin: true, via: 'session' },
  'admin-token': { email: 'boss@example.test', admin: true, via: 'api_key' },
  impersonating: {
    email: 'member@example.test',
    admin: false,
    via: 'session',
    impersonator: 'boss@example.test',
  },
  user: { email: 'member@example.test', admin: false, via: 'session' },
}

describe('canInstance', () => {
  it('covers every action', () => {
    expect(Object.keys(INSTANCE_EXPECTED).sort()).toEqual([...INSTANCE_ACTIONS].sort())
  })

  for (const action of INSTANCE_ACTIONS) {
    for (const role of PRINCIPAL_ROLES) {
      const allowed = INSTANCE_EXPECTED[action].includes(ROLE_LETTER[role])
      it(`${role} ${allowed ? 'may' : 'may not'} ${action}`, () => {
        expect(canInstance(principalFor[role], action)).toBe(allowed)
      })
    }
  }

  it('resolves roles: impersonating wins, an admin is a token-admin off a browser session', () => {
    expect(principalRole({ email: 'u@x.test', admin: false, via: 'api_key' })).toBe('user')
    expect(principalRole({ email: 'u@x.test', admin: true, via: 'oauth' })).toBe('admin-token')
    for (const role of PRINCIPAL_ROLES) expect(principalRole(principalFor[role])).toBe(role)
  })

  it('refuses to impersonate nobody, yourself or an admin', () => {
    const boss = principalFor.admin
    expect(impersonationRefusal(boss, null)).toBe('no_such_user')
    expect(impersonationRefusal(boss, { email: boss.email, admin: true })).toBe('self')
    expect(impersonationRefusal(boss, { email: 'other@example.test', admin: true })).toBe('admin')
    expect(impersonationRefusal(boss, { email: 'm@example.test', admin: false })).toBeNull()
  })

  it("gives admins nothing on other people's sites: an admin is a member there", () => {
    // `can` has no notion of admins; an admin's actor is a user like any other.
    const admin: Actor = { kind: 'user', email: principalFor.admin.email }
    for (const action of ACTIONS) {
      for (const access of ACCESSES) {
        expect(can(admin, action, siteWith(access))).toBe(
          can(actorFor.member, action, siteWith(access))
        )
      }
    }
  })
})

describe('canDeleteComment', () => {
  const site = siteWith('private')
  const by = (email: string) => ({ author: { kind: 'user' as const, email } })
  const guest = { author: { kind: 'guest' as const, name: 'Pat' } }

  it("the owner deletes anyone's; a member only their own; share and anonymous nothing", () => {
    const memberEmail = 'member@example.test'
    const expected: Record<Role, [boolean, boolean, boolean]> = {
      // [the owner's comment, the member's comment, a guest's comment]
      owner: [true, true, true],
      viewer: [false, false, false],
      member: [false, true, false],
      share: [false, false, false],
      anonymous: [false, false, false],
    }
    for (const role of ROLES) {
      const got = [by(OWNER), by(memberEmail), guest].map(c =>
        canDeleteComment(actorFor[role], site, c)
      )
      expect({ role, got }).toEqual({ role, got: expected[role] })
    }
  })
})

describe('roleOf', () => {
  const site = siteWith('private')

  it('owner is the user holding the site; one in its audience a viewer; any other a member', () => {
    expect(roleOf(actorFor.owner, site)).toBe('owner')
    expect(roleOf(actorFor.member, site)).toBe('member')
    expect(roleOf(actorFor.viewer, siteWith('restricted'))).toBe('viewer')
    expect(roleOf(actorFor.viewer, site)).toBe('member')
  })

  it("only the site's current share token makes a share actor", () => {
    expect(roleOf({ kind: 'share', token: TOKEN }, site)).toBe('share')
    expect(roleOf({ kind: 'share', token: 'zyxwvutsrq9876543210' }, site)).toBe('anonymous')
    expect(roleOf({ kind: 'share', token: TOKEN }, { ...site, shareToken: null })).toBe('anonymous')
  })
})

describe('roleOf through a group', () => {
  it("a user in one of the audience's groups is a viewer; the groups are the actor's", () => {
    const site: PolicySite = { ...siteWith('private'), audience: { emails: [], groups: ['g1'] } }
    const member = actorFor.member as Extract<Actor, { kind: 'user' }>
    expect(roleOf({ ...member, groups: ['g1'] }, site)).toBe('viewer')
    expect(roleOf({ ...member, groups: ['g2'] }, site)).toBe('member')
    expect(roleOf(member, site)).toBe('member')
    expect(can({ ...member, groups: ['g1'] }, 'site.view', site)).toBe(true)
    expect(can({ ...member, groups: ['g2'] }, 'site.view', site)).toBe(false)
  })
})

/** Who may do each group action: o = its owner, m = any other signed-in user. */
const GROUP_EXPECTED: Record<GroupAction, string> = {
  'group.read': 'om',
  'group.manage': 'o',
  'group.delete': 'o',
}

describe('canGroup', () => {
  const group = { owner: OWNER }
  const actors: Record<string, Actor> = {
    o: { kind: 'user', email: OWNER },
    m: { kind: 'user', email: 'member@example.test' },
  }

  it.each(GROUP_ACTIONS)('%s', action => {
    const got = Object.entries(actors)
      .filter(([, actor]) => canGroup(actor, action, group))
      .map(([letter]) => letter)
      .join('')
    expect(got).toBe(GROUP_EXPECTED[action])
  })

  it('share-link holders and anonymous visitors get nothing', () => {
    for (const action of GROUP_ACTIONS) {
      expect(canGroup(actorFor.share, action, group)).toBe(false)
      expect(canGroup(actorFor.anonymous, action, group)).toBe(false)
    }
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
  async function sites() {
    const env = setup()
    const owner = await createUser(env, 'alice@example.test')
    const viewer = await createUser(env, 'bob@example.test')
    const member = await createUser(env, 'carol@example.test')
    await deploy(env, owner.key, 'pub', { visibility: 'public' })
    await deploy(env, owner.key, 'priv', { visibility: 'private' })
    for (const name of ['team', 'other']) {
      await deploy(env, owner.key, name, { visibility: 'private' })
      const res = await api(env, owner.key, 'PATCH', `/api/sites/${name}`, {
        audience: { emails: ['bob@example.test'] },
      })
      expect(res.status).toBe(200)
    }
    // The platform entry (lambda.ts, dev.ts) puts the cookie key where the edge reads it.
    await env.routeTable.put(SITE_HMAC_KVS_KEY, env.config.secrets.siteHmacKey)
    const now = env.deps.clock.now().getTime()
    const router = createSiteRouter({
      kvs: env.routeTable,
      appOrigin: env.config.appOrigin,
      now: () => now,
    })
    const key = env.config.secrets.siteHmacKey
    const x = Math.floor(now / 1000) + 60
    const siteCookie = (email: string) => `fling_site=${signSiteCookie({ e: email, x }, key)}`
    const pass = async (email: string, name: string, exp = x) => {
      const site = (await env.store.findSite(name)) as PolicySite & { id: string }
      return `fling_pass=${signSitePass({ s: site.id, e: email, x: exp }, key)}`
    }
    const served = async (host: string, cookieHeader?: string) => {
      const result = await router(toCloudFrontEvent({ path: '/', host, cookieHeader }))
      return !isResponse(result) && result.uri.startsWith('/sites/')
    }
    return { env, owner, viewer, member, router, siteCookie, pass, served }
  }

  it('for every role and access', async () => {
    const { env, owner, siteCookie, pass, served } = await sites()
    for (const name of ['pub', 'priv', 'team']) {
      const share = await json(await api(env, owner.key, 'POST', `/api/sites/${name}/share`))
      const shareHost = new URL(share.shareUrl).host
      const site = (await env.store.findSite(name)) as PolicySite
      // What each role's browser holds: a site pass only where the API would hand one out.
      const cookieOf = async (email: string) =>
        can({ kind: 'user', email }, 'site.view', site) && name === 'team'
          ? pass(email, name)
          : siteCookie(email)
      const requests: Record<Role, [string, string?]> = {
        owner: [`${name}.fling.test`, await cookieOf('alice@example.test')],
        viewer: [`${name}.fling.test`, await cookieOf('bob@example.test')],
        member: [`${name}.fling.test`, await cookieOf('carol@example.test')],
        share: [shareHost],
        anonymous: [`${name}.fling.test`],
      }
      const actors: Record<Role, Actor> = {
        owner: { kind: 'user', email: 'alice@example.test' },
        viewer: { kind: 'user', email: 'bob@example.test' },
        member: { kind: 'user', email: 'carol@example.test' },
        share: { kind: 'share', token: shareHost.split('.')[0]?.slice(3) ?? '' },
        anonymous: { kind: 'anonymous' },
      }
      expect(env.routeTable.data.has(siteKvsKey(name))).toBe(true)
      for (const role of ROLES) {
        expect({ name, role, served: await served(...requests[role]) }).toEqual({
          name,
          role,
          served: can(actors[role], 'site.view', site),
        })
      }
    }
  })

  it("a restricted site wants its own pass: not a member cookie, another site's pass or an expired one", async () => {
    const { env, siteCookie, pass, served } = await sites()
    expect(await served('team.fling.test', await pass('bob@example.test', 'team'))).toBe(true)
    expect(await served('team.fling.test', siteCookie('bob@example.test'))).toBe(false)
    expect(await served('team.fling.test', await pass('bob@example.test', 'other'))).toBe(false)
    const now = Math.floor(env.deps.clock.now().getTime() / 1000)
    expect(await served('team.fling.test', await pass('bob@example.test', 'team', now))).toBe(false)
  })

  it('/auth/login hands a viewer a pass the edge accepts, and anyone else the 404 page', async () => {
    const { env, owner, viewer, member, router } = await sites()
    const login = (session: string, ret: string) =>
      env.app.request(`/auth/login?return=${encodeURIComponent(ret)}`, {
        headers: { cookie: `__Host-fling_session=${session}` },
      })
    const ret = 'https://team.fling.test/docs/?q=1'
    for (const who of [owner, viewer]) {
      const res = await login(who.session, ret)
      const location = new URL(res.headers.get('location') ?? '')
      expect(`${location.origin}${location.pathname}`).toBe('https://team.fling.test/_fling-pass')
      expect(location.searchParams.get('r')).toBe('/docs/?q=1')
      // The edge turns the handoff into a pass, then serves the site with it.
      const handoff = await router(
        toCloudFrontEvent({
          host: location.host,
          path: location.pathname,
          query: location.search.slice(1),
        })
      )
      if (!isResponse(handoff)) throw new Error('expected a redirect')
      expect(handoff.headers?.location?.value).toBe('/docs/?q=1')
      const cookie = handoff.cookies?.fling_pass?.value
      expect(cookie).toBeTruthy()
      const page = await router(
        toCloudFrontEvent({ host: location.host, path: '/', cookieHeader: `fling_pass=${cookie}` })
      )
      expect(!isResponse(page) && page.uri.startsWith('/sites/')).toBe(true)
    }
    const refused = await login(member.session, ret)
    expect(refused.headers.get('location')).toBe('https://team.fling.test/_fling/404.html')
    // Other sites go straight back, as ever.
    const priv = await login(member.session, 'https://priv.fling.test/')
    expect(priv.headers.get('location')).toBe('https://priv.fling.test/')
    expect(cookiesOf(priv).fling_site).toBeDefined()
  })

  it('a handoff expires after 60 seconds', async () => {
    const { env, viewer } = await sites()
    const res = await env.app.request(
      `/auth/login?return=${encodeURIComponent('https://team.fling.test/')}`,
      { headers: { cookie: `__Host-fling_session=${viewer.session}` } }
    )
    const location = new URL(res.headers.get('location') ?? '')
    await env.routeTable.put(SITE_HMAC_KVS_KEY, env.config.secrets.siteHmacKey)
    const later = env.deps.clock.now().getTime() + 61_000
    const router = createSiteRouter({
      kvs: env.routeTable,
      appOrigin: env.config.appOrigin,
      now: () => later,
    })
    const result = await router(
      toCloudFrontEvent({
        host: location.host,
        path: location.pathname,
        query: location.search.slice(1),
      })
    )
    expect(isResponse(result) && result.cookies).toBeFalsy()
  })
})

describe("a member can't act on another user's site", () => {
  async function twoUsers() {
    const env = setup()
    const alice = await createUser(env, 'alice@example.test')
    const bob = await createUser(env, 'bob@example.test')
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
      ['PATCH', '/api/sites/hello', { audience: { emails: ['bob@example.test'] } }],
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
    const { accessToken } = await connect(env, 'bob@example.test')
    const calls: [string, object][] = [
      ['fling_info', { name: 'hello' }],
      ['fling_files', { name: 'hello' }],
      ['fling_share', { name: 'hello' }],
      ['fling_share', { name: 'hello', refresh: true }],
      ['fling_share', { name: 'hello', revoke: true }],
      ['fling_set_visibility', { name: 'hello', visibility: 'private' }],
      ['fling_set_audience', { name: 'hello', add: ['bob@example.test'] }],
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
    const alice = await createUser(env, 'alice@example.test')
    const bob = await createUser(env, 'bob@example.test')
    await deploy(env, bob.key, 'hello')
    // Alice's old site record for the name, left behind while Bob holds the claim.
    await env.table.put({
      pk: 'USER#alice@example.test',
      sk: 'SITE#hello',
      type: 'site',
      id: 'stale',
      email: 'alice@example.test',
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
