/**
 * Standing (auth/standing.ts): who may be signed in, and as what, rechecked on every request. The
 * matrix, then what it does to each credential (session, API key, OAuth and MCP) and what a guest
 * may reach. Invitations are written straight into the store here.
 */
import { describe, expect, it, vi } from 'vitest'
import { type Standing, standingFrom, standingOf } from '../src/auth/standing.ts'
import type { InvitationRecord } from '../src/store/types.ts'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'
import {
  authorizeUrl,
  CLAUDE_CALLBACK,
  connect,
  pkce,
  RESOURCE,
  register,
  rpc,
  SESSION,
  token,
} from './oauth-helpers.ts'

const GUEST = 'guest@outside.test'
const OUTSIDER = 'pat@outside.test'

const invite = (env: Env, email: string, role: 'member' | 'guest') =>
  env.store.putInvitation({
    email,
    role,
    invitedBy: 'alice@example.test',
    via: role === 'member' ? 'admin' : 'share',
    createdAt: env.deps.clock.now().toISOString(),
  })

const revoke = (env: Env, email: string) =>
  env.store.revokeInvitation(email, env.deps.clock.now().toISOString())

const page = [file('index.html', '<h1>hi</h1>')]

async function deploy(env: Env, key: string, name: string, extra = {}) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: page.map(f => f.meta) },
    ...extra,
  })
  const body = await json(res)
  if (body.status !== 'upload') return body
  await upload(env, body.uploads, page)
  return json(await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`))
}

/** Name `emails` in the site's audience, straight in the store (outside addresses included). */
async function shareWith(env: Env, name: string, emails: string[]) {
  const site = await env.store.findSite(name)
  if (!site) throw new Error(`no site ${name}`)
  await env.store.putSite({
    ...site,
    restricted: true,
    audience: { emails, groups: [] },
    updatedAt: env.deps.clock.now().toISOString(),
  })
}

const sessionGet = (env: Env, session: string, path: string) =>
  env.app.request(path, { headers: { cookie: `${SESSION}=${session}` } })

describe('standingFrom', () => {
  const at = '2026-01-01T00:00:00.000Z'
  const inv = (role: 'member' | 'guest', revoked = false): InvitationRecord => ({
    email: OUTSIDER,
    role,
    invitedBy: 'a@example.test',
    via: 'admin',
    createdAt: at,
    updatedAt: at,
    ...(revoked ? { revokedAt: at } : {}),
  })
  const cases: [string, InvitationRecord | null, boolean, Standing][] = [
    ['no invitation', null, true, 'none'],
    ['a member invitation', inv('member'), false, 'member'],
    ['a revoked member invitation', inv('member', true), true, 'none'],
    ['a guest invitation nothing names', inv('guest'), false, 'none'],
    ['a guest invitation an audience names', inv('guest'), true, 'guest'],
    ['a revoked guest invitation an audience names', inv('guest', true), true, 'none'],
  ]
  it.each(cases)('%s → %s', (_, invitation, named, standing) => {
    expect(standingFrom(invitation, named)).toBe(standing)
  })
})

describe('standingOf', () => {
  it('admits the policy and admins from configuration alone, with no store read', async () => {
    const env = setup({ adminEmails: ['boss@example.test'] })
    const read = vi.spyOn(env.store, 'getInvitation')
    expect(await standingOf(env.deps, 'anyone@example.test')).toBe('member')
    expect(await standingOf(env.deps, 'boss@example.test')).toBe('member')
    expect(read).not.toHaveBeenCalled()
  })

  it('reads the invitation for anyone else, and a guest needs an audience or a group to name them', async () => {
    const env = setup()
    const owner = await createUser(env)
    expect(await standingOf(env.deps, OUTSIDER)).toBe('none')
    await invite(env, OUTSIDER, 'member')
    expect(await standingOf(env.deps, OUTSIDER)).toBe('member')
    await revoke(env, OUTSIDER)
    expect(await standingOf(env.deps, OUTSIDER)).toBe('none')

    await invite(env, GUEST, 'guest')
    expect(await standingOf(env.deps, GUEST)).toBe('none')
    await deploy(env, owner.key, 'docs')
    await shareWith(env, 'docs', [GUEST])
    expect(await standingOf(env.deps, GUEST)).toBe('guest')
    await shareWith(env, 'docs', [])
    expect(await standingOf(env.deps, GUEST)).toBe('none')
    const group = await env.store.createGroup(
      {
        id: 'g1',
        slug: 'team',
        name: 'Team',
        owner: 'alice@example.test',
        size: 1,
        createdAt: env.deps.clock.now().toISOString(),
        updatedAt: env.deps.clock.now().toISOString(),
      },
      [GUEST]
    )
    expect(group).not.toBeNull()
    expect(await standingOf(env.deps, GUEST)).toBe('guest')
    await revoke(env, GUEST)
    expect(await standingOf(env.deps, GUEST)).toBe('none')
  })
})

describe('every request rechecks standing', () => {
  it('revoking an invitation cuts an existing session and API key on the next request', async () => {
    const env = setup()
    await invite(env, OUTSIDER, 'member')
    const pat = await createUser(env, OUTSIDER)
    expect((await api(env, pat.key, 'GET', '/api/me')).status).toBe(200)
    expect((await sessionGet(env, pat.session, '/api/me')).status).toBe(200)
    await revoke(env, OUTSIDER)
    expect((await api(env, pat.key, 'GET', '/api/me')).status).toBe(401)
    expect((await sessionGet(env, pat.session, '/api/me')).status).toBe(401)
    // Invited again, the same credentials work again: nothing was deleted.
    await invite(env, OUTSIDER, 'member')
    expect((await api(env, pat.key, 'GET', '/api/me')).status).toBe(200)
  })

  it('removing a domain from the policy cuts its users', async () => {
    const env = setup()
    const alice = await createUser(env)
    expect((await api(env, alice.key, 'GET', '/api/me')).status).toBe(200)
    env.config.allowedEmailDomains = ['elsewhere.test']
    expect((await api(env, alice.key, 'GET', '/api/me')).status).toBe(401)
    expect((await sessionGet(env, alice.session, '/api/me')).status).toBe(401)
  })

  it('a guest no audience names any more is cut off, and a new share brings them back', async () => {
    const env = setup()
    const owner = await createUser(env)
    await deploy(env, owner.key, 'docs')
    await invite(env, GUEST, 'guest')
    await shareWith(env, 'docs', [GUEST])
    const guest = await createUser(env, GUEST)
    expect((await api(env, guest.key, 'GET', '/api/shared')).status).toBe(200)
    await shareWith(env, 'docs', [])
    expect((await api(env, guest.key, 'GET', '/api/shared')).status).toBe(401)
    await shareWith(env, 'docs', [GUEST])
    expect((await api(env, guest.key, 'GET', '/api/shared')).status).toBe(200)
  })

  it('OAuth: a revoked invitation refuses the access token and the refresh', async () => {
    const env = setup()
    await invite(env, OUTSIDER, 'member')
    const conn = await connect(env, OUTSIDER)
    expect((await rpc(env, conn.accessToken, 'tools/list')).status).toBe(200)
    await revoke(env, OUTSIDER)
    expect((await rpc(env, conn.accessToken, 'tools/list')).status).toBe(401)
    const refreshed = await token(env, {
      grant_type: 'refresh_token',
      refresh_token: conn.refreshToken,
      client_id: conn.clientId,
    })
    expect(refreshed.status).toBe(400)
    expect((await json(refreshed)).error).toBe('invalid_grant')
  })

  it('dev login admits by standing too', async () => {
    const env = setup({ devLogin: true, secureCookies: false })
    const res = await env.app.request(`/auth/dev-login?email=${OUTSIDER}`)
    expect(res.headers.get('location')).toBe('/login?error=domain_not_allowed')
    expect(await env.store.getUser(OUTSIDER)).toBeNull()
    await invite(env, OUTSIDER, 'member')
    const admitted = await env.app.request(`/auth/dev-login?email=${OUTSIDER}`)
    expect(admitted.status).toBe(302)
    expect(await env.store.getUser(OUTSIDER)).not.toBeNull()
  })
})

describe('a guest', () => {
  async function world() {
    const env = setup()
    const owner = await createUser(env)
    await deploy(env, owner.key, 'shared')
    await deploy(env, owner.key, 'everyone', { access: 'members' })
    await deploy(env, owner.key, 'open', { access: 'public' })
    await invite(env, GUEST, 'guest')
    await shareWith(env, 'shared', [GUEST])
    const guest = await createUser(env, GUEST)
    return { env, owner, guest }
  }

  it('reviews the sites shared with them and public ones, and nothing members-only', async () => {
    const { env, guest } = await world()
    const shared = await json(await api(env, guest.key, 'GET', '/api/shared'))
    expect(shared.sites.map((s: { name: string }) => s.name)).toEqual(['shared'])
    for (const name of ['shared', 'open']) {
      expect((await api(env, guest.key, 'GET', `/api/sites/${name}/comments`)).status).toBe(200)
      const add = await api(env, guest.key, 'POST', `/api/sites/${name}/comments`, {
        path: '/',
        versionId: (await env.store.findSite(name))?.currentVersionId,
        body: 'Looks good',
      })
      expect({ name, status: add.status }).toEqual({ name, status: 201 })
    }
    const members = await api(env, guest.key, 'GET', '/api/sites/everyone/comments')
    expect(members.status).toBe(404)
  })

  it('creates no sites or groups, lists no groups and checks no names (403 guest)', async () => {
    const { env, owner, guest } = await world()
    await api(env, owner.key, 'POST', '/api/groups', { slug: 'team', name: 'Team', members: [] })
    const refused: [string, string, object?][] = [
      ['POST', '/api/sites/mine/deploys', { manifest: { files: page.map(f => f.meta) } }],
      ['GET', '/api/names/mine'],
      ['GET', '/api/groups'],
      ['GET', '/api/groups/team'],
      ['POST', '/api/groups', { slug: 'mine', name: 'Mine', members: [] }],
    ]
    for (const [method, path, body] of refused) {
      const res = await api(env, guest.key, method, path, body)
      expect({ method, path, status: res.status, code: (await json(res)).error?.code }).toEqual({
        method,
        path,
        status: 403,
        code: 'guest',
      })
    }
    expect(await env.store.findSite('mine')).toBeNull()
  })

  it('mints no API keys and connects no apps', async () => {
    const { env, guest } = await world()
    const cookie = { cookie: `${SESSION}=${guest.session}` }
    const cli = await env.app.request(
      '/auth/cli?redirect_uri=http://127.0.0.1:5000/callback&hostname=laptop',
      { headers: cookie }
    )
    expect(new URL(cli.headers.get('location') ?? '').searchParams.get('error')).toBe('guest')
    expect(await env.store.listApiKeys(GUEST)).toHaveLength(1)
    const clientId = (await json(await register(env))).client_id as string
    const authorize = await env.app.request(
      authorizeUrl({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        state: 'st4te',
        scope: 'fling',
        resource: RESOURCE,
      }),
      { headers: cookie }
    )
    const denied = new URL(authorize.headers.get('location') ?? '', 'https://fling.test')
    expect(denied.pathname).toBe('/authorize')
    expect(denied.searchParams.get('error')).toBe('access_denied')
  })

  it('gets only the reviewing tools over MCP', async () => {
    const { env, guest } = await world()
    const res = await rpc(env, guest.key, 'tools/list')
    const names = ((await json(res)).result.tools as { name: string }[]).map(t => t.name)
    expect(names).toContain('fling_list')
    expect(names).toContain('fling_comments_list')
    for (const tool of ['fling_publish', 'fling_info', 'fling_check_name', 'fling_groups']) {
      expect(names).not.toContain(tool)
    }
  })
})
