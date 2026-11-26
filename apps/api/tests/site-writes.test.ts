/**
 * A request that read a site at its start and saves it at its end (a publisher's finalize,
 * rollback or thumbnail) never undoes what an owner or an admin changed while it ran: removing the
 * publisher, narrowing the audience, revoking the share link, archiving, deleting, stopping the
 * server. Each change is made deterministically inside the request, by a one-shot hook on a store
 * or blob method the request calls after its read.
 */
import { shareKvsKey, siteKvsKey } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import type { SiteServers } from '../src/servers/types.ts'
import { APP_ORIGIN, api, createUser, type Env, file, json, PNG, setup, upload } from './helpers.ts'
import { SESSION } from './oauth-helpers.ts'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const CAROL = 'carol@example.test'
const DAN = 'dan@example.test'
const BOSS = 'boss@example.test'

const servers: SiteServers = {
  activate: async () => ({ target: 'fn.servers.example.test' }),
  probe: async () => ({ ok: true, status: 200, logs: [] }),
  reconfigure: async () => ({ target: 'fn.servers.example.test' }),
  setEnabled: async () => {},
  retire: async () => {},
  invoke: async () => new Response('ok'),
}

const pageOf = (text: string) => [file('index.html', `<h1>${text}</h1>`)]

/** Stage and upload `files` to `team` with the key: the version to finalize. */
async function stage(env: Env, key: string, text: string, extra: object = {}) {
  const files = pageOf(text)
  const res = await api(env, key, 'POST', '/api/sites/team/deploys', {
    manifest: { files: files.map(f => f.meta) },
    ...extra,
  })
  const body = await json(res)
  expect(body.status).toBe('upload')
  await upload(env, body.uploads, files)
  return body.versionId as string
}

const finalize = (env: Env, key: string, versionId: string) =>
  api(env, key, 'POST', `/api/sites/team/deploys/${versionId}/finalize`)

/**
 * Alice owns `team`, live at v1, open to Carol and Dan, with a share link; Bob publishes it; Boss
 * is an admin.
 */
async function world() {
  const env = setup({ adminEmails: [BOSS] })
  env.config.servers = { ...env.config.servers, publish: { kind: 'members' } }
  env.deps.servers = servers
  const [alice, bob, boss] = await Promise.all([
    createUser(env, ALICE),
    createUser(env, BOB),
    createUser(env, BOSS),
    createUser(env, CAROL),
    createUser(env, DAN),
  ])
  const v1 = await stage(env, alice.key, 'v1', {
    access: 'people',
    audience: { emails: [CAROL, DAN] },
  })
  expect((await finalize(env, alice.key, v1)).status).toBe(200)
  const patched = await api(env, alice.key, 'PATCH', '/api/sites/team', {
    publishers: { emails: [BOB] },
  })
  expect(patched.status).toBe(200)
  expect((await api(env, alice.key, 'POST', '/api/sites/team/share')).status).toBe(200)
  const token = (await env.store.findSite('team'))?.shareToken as string
  return { env, alice, bob, boss, v1, token }
}

type World = Awaited<ReturnType<typeof world>>

/** Run `action` once, the first time `target[method]` is called, before the call itself. */
function during<T extends object>(target: T, method: keyof T, action: () => Promise<unknown>) {
  const original = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target)
  let fired = false
  ;(target as Record<keyof T, unknown>)[method] = async (...args: unknown[]) => {
    if (!fired) {
      fired = true
      await action()
    }
    return original(...args)
  }
}

const grantsOf = async (env: Env, email: string) =>
  (await env.store.listSiteGrants(email)).filter(g => g.name === 'team')

/** The owners' and admin's changes, each with what must still hold once the request is done. */
const changes: {
  name: string
  make: (w: World) => Response | Promise<Response>
  holds: (w: World) => Promise<void>
}[] = [
  {
    name: 'the owner removes the publisher',
    make: ({ env, alice }) =>
      api(env, alice.key, 'PATCH', '/api/sites/team', { publishers: { emails: [] } }),
    holds: async ({ env }) => {
      expect((await env.store.findSite('team'))?.publishers.emails).toEqual([])
      expect(await env.store.listRoleSites(BOB)).toEqual([])
    },
  },
  {
    name: 'the owner narrows the audience',
    make: ({ env, alice }) =>
      api(env, alice.key, 'PATCH', '/api/sites/team', {
        access: 'people',
        audience: { emails: [CAROL] },
      }),
    holds: async ({ env }) => {
      expect((await env.store.findSite('team'))?.audience.emails).toEqual([CAROL])
      expect(await grantsOf(env, DAN)).toEqual([])
      expect(await grantsOf(env, CAROL)).toHaveLength(1)
    },
  },
  {
    name: 'the owner revokes the share link',
    make: ({ env, alice }) => api(env, alice.key, 'DELETE', '/api/sites/team/share'),
    holds: async ({ env, token }) => {
      expect((await env.store.findSite('team'))?.shareToken).toBeNull()
      expect(await env.routeTable.get(shareKvsKey(token))).toBeUndefined()
    },
  },
  {
    name: 'the owner archives the site',
    make: ({ env, alice }) => api(env, alice.key, 'POST', '/api/sites/team/archive'),
    holds: async ({ env }) => {
      expect((await env.store.findSite('team'))?.archived).toBe(true)
      expect(await env.routeTable.get(siteKvsKey('team'))).toBeUndefined()
    },
  },
  {
    name: 'the owner deletes the site',
    make: ({ env, alice }) => api(env, alice.key, 'DELETE', '/api/sites/team'),
    holds: async ({ env }) => {
      expect(await env.store.findSite('team')).toBeNull()
      expect(await env.store.listRoleSites(BOB)).toEqual([])
      expect(await grantsOf(env, CAROL)).toEqual([])
      expect(await env.routeTable.get(siteKvsKey('team'))).toBeUndefined()
    },
  },
  {
    name: 'an admin stops its server',
    make: ({ env, boss }) =>
      env.app.request('/api/admin/sites/team/server', {
        method: 'PUT',
        headers: {
          cookie: `${SESSION}=${boss.session}`,
          origin: APP_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ stopped: true }),
      }),
    holds: async ({ env }) => {
      expect((await env.store.findSite('team'))?.server?.stopped).toBe(true)
    },
  },
]

/** What the request answers after each change: refused where the change takes its right away. */
const answers: Record<string, Record<string, number>> = {
  finalize: {
    'the owner removes the publisher': 404,
    'the owner archives the site': 400,
    'the owner deletes the site': 404,
  },
  rollback: {
    'the owner removes the publisher': 404,
    'the owner deletes the site': 404,
  },
  thumbnail: {
    'the owner removes the publisher': 404,
    'the owner archives the site': 409,
    'the owner deletes the site': 404,
  },
}

describe("a publisher's finalize", () => {
  for (const change of changes) {
    it(`keeps what happens meanwhile: ${change.name}`, async () => {
      const w = await world()
      const v2 = await stage(w.env, w.bob.key, 'v2')
      // After the uploads are checked and scanned: the manifest written as the version goes live.
      during(w.env.blobs, 'putJson', async () =>
        expect((await change.make(w)).status).toBeLessThan(300)
      )
      const res = await finalize(w.env, w.bob.key, v2)
      const status = answers.finalize?.[change.name] ?? 200
      expect(res.status).toBe(status)
      await change.holds(w)
      const site = await w.env.store.findSite('team')
      if (site) expect(site.currentVersionId).toBe(status === 200 ? v2 : w.v1)
    })
  }
})

describe("a publisher's rollback", () => {
  for (const change of changes) {
    it(`keeps what happens meanwhile: ${change.name}`, async () => {
      const w = await world()
      const v2 = await stage(w.env, w.alice.key, 'v2')
      expect((await finalize(w.env, w.alice.key, v2)).status).toBe(200)
      during(w.env.store, 'getVersion', async () =>
        expect((await change.make(w)).status).toBeLessThan(300)
      )
      const res = await api(w.env, w.bob.key, 'POST', '/api/sites/team/current', {
        versionId: w.v1,
      })
      const status = answers.rollback?.[change.name] ?? 200
      expect(res.status).toBe(status)
      await change.holds(w)
      const site = await w.env.store.findSite('team')
      if (site) expect(site.currentVersionId).toBe(status === 200 ? w.v1 : v2)
    })
  }
})

describe("a publisher's thumbnail", () => {
  for (const change of changes) {
    it(`keeps what happens meanwhile: ${change.name}`, async () => {
      const w = await world()
      during(w.env.blobs, 'put', async () =>
        expect((await change.make(w)).status).toBeLessThan(300)
      )
      const res = await w.env.app.request(`/api/sites/team/thumbnail?version=${w.v1}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${w.bob.key}`, 'content-type': 'image/png' },
        body: PNG,
      })
      const status = answers.thumbnail?.[change.name] ?? 200
      expect(res.status).toBe(status)
      await change.holds(w)
      const site = await w.env.store.findSite('team')
      if (status === 200) expect(site?.thumbnail?.versionId).toBe(w.v1)
      else expect(site?.thumbnail).toBeUndefined()
    })
  }
})

describe("a publisher's Path publish, refreshing the site's Paths and home page", () => {
  const kept = changes.filter(c => (answers.finalize?.[c.name] ?? 200) === 200)
  for (const change of kept) {
    it(`keeps what happens meanwhile: ${change.name}`, async () => {
      const w = await world()
      const files = [file('wk44/index.html', '<h1>week</h1>')]
      const staged = await json(
        await api(w.env, w.bob.key, 'POST', '/api/sites/team/deploys', {
          manifest: { files: files.map(f => f.meta) },
          path: 'wk44',
        })
      )
      await upload(w.env, staged.uploads, files)
      // The Path is written, then the site's Paths flag (`refreshHome`) on the copy read at start.
      during(w.env.store, 'putPath', async () =>
        expect((await change.make(w)).status).toBeLessThan(300)
      )
      expect((await finalize(w.env, w.bob.key, staged.versionId)).status).toBe(200)
      await change.holds(w)
      expect((await w.env.store.findSite('team'))?.paths).toBe(true)
    })
  }
})
