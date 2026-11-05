/**
 * maintenance.ts on the test clock: retention keeps the current version and the newest N, marks
 * the rest and sweeps them only after the grace period; a marked version that is published again
 * or rolled back to comes back; one being swept is 409 retry_later; Paths are kept the same way;
 * an abandoned pending deploy goes too; replaced home pages are deleted after the grace period.
 */
import { siteObjectKey } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { manifestKey } from '../src/blobs/types.ts'
import { GRACE_MS, maintain, PENDING_TTL_MS } from '../src/maintenance.ts'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'

const ALICE = 'alice@example.test'
const MINUTE = 60_000

type F = ReturnType<typeof file>

async function deploy(env: Env, key: string, name: string, files: F[], extra: object = {}) {
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...extra,
  })
  const body = await json(res)
  if (body.status !== 'upload') return { status: res.status, body }
  await upload(env, body.uploads, files)
  const done = await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
  return { status: done.status, body: await json(done) }
}

/** Five versions of `docs`, a minute apart (v1 oldest, v5 current), retention `keep`. */
async function world(keep = 2) {
  const env = setup({ versionRetention: keep })
  const alice = await createUser(env, ALICE)
  const ids: string[] = []
  for (let i = 1; i <= 5; i++) {
    const done = await deploy(env, alice.key, 'docs', [file('index.html', `<h1>v${i}</h1>`)])
    ids.push(done.body.versionId)
    env.advance(MINUTE)
  }
  const site = await env.store.findSite('docs')
  return { env, alice, ids, site: site as NonNullable<typeof site> }
}

const statuses = async (env: Env, ref: { id: string; email: string }) =>
  Object.fromEntries((await env.store.listVersions(ref)).map(v => [v.id, v.status]))

describe('retention', () => {
  it('keeps the current version and the newest N; marks the rest, sweeps them after the grace', async () => {
    const { env, ids, site } = await world(2)
    const [v1, v2, v3, v4, v5] = ids as [string, string, string, string, string]
    const first = await maintain(env.deps)
    expect(first).toMatchObject({ marked: 2, swept: 0 })
    expect(await statuses(env, site)).toEqual({
      [v1]: 'pruning',
      [v2]: 'pruning',
      [v3]: 'complete',
      [v4]: 'complete',
      [v5]: 'complete',
    })
    // Within the grace period nothing is deleted.
    env.advance(GRACE_MS - MINUTE)
    expect((await maintain(env.deps)).swept).toBe(0)
    expect(await env.blobs.get(siteObjectKey(site.id, v1, 'index.html'))).not.toBeNull()
    env.advance(2 * MINUTE)
    expect((await maintain(env.deps)).swept).toBe(2)
    expect(Object.keys(await statuses(env, site)).sort()).toEqual([v3, v4, v5].sort())
    expect(await env.blobs.get(siteObjectKey(site.id, v1, 'index.html'))).toBeNull()
    expect(await env.blobs.getJson(manifestKey(site.id, v1))).toBeNull()
    // Done is done: another run changes nothing.
    expect(await maintain(env.deps)).toMatchObject({ marked: 0, swept: 0 })
  })

  it('0 keeps every version', async () => {
    const { env, site } = await world(0)
    expect(await maintain(env.deps)).toMatchObject({ marked: 0, swept: 0 })
    expect(await env.store.listVersions(site)).toHaveLength(5)
  })

  it('a marked version published again or rolled back to comes back, and is never swept', async () => {
    const { env, alice, ids, site } = await world(2)
    const [v1, v2] = ids as [string, string]
    await maintain(env.deps)
    const again = await deploy(env, alice.key, 'docs', [file('index.html', '<h1>v1</h1>')])
    expect(again.body).toMatchObject({ status: 'repointed', versionId: v1 })
    expect((await env.store.getVersion(site, v1))?.status).toBe('complete')
    const back = await api(env, alice.key, 'POST', '/api/sites/docs/current', { versionId: v2 })
    expect(back.status).toBe(200)
    env.advance(GRACE_MS + MINUTE)
    await maintain(env.deps)
    // v2 is current, so kept; v1, current no longer and past the newest two again, is marked.
    const now = await statuses(env, site)
    expect(now[v2]).toBe('complete')
    expect(now[v1]).toBe('pruning')
  })

  it('a version being swept is 409 retry_later to a publish of its files', async () => {
    const { env, alice, ids, site } = await world(2)
    const v1 = ids[0] as string
    await maintain(env.deps)
    const marked = await env.store.getVersion(site, v1)
    await env.store.moveVersion(site, 'pruning', {
      ...(marked as NonNullable<typeof marked>),
      status: 'sweeping',
    })
    const refused = await deploy(env, alice.key, 'docs', [file('index.html', '<h1>v1</h1>')])
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('retry_later')
  })

  it('keeps each Path the same way, by itself', async () => {
    const { env, alice, site } = await world(1)
    const pathIds: string[] = []
    for (let i = 1; i <= 3; i++) {
      const done = await deploy(env, alice.key, 'docs', [file('P/index.html', `p${i}`)], {
        path: 'P',
      })
      pathIds.push(done.body.versionId)
      env.advance(MINUTE)
    }
    await maintain(env.deps)
    env.advance(GRACE_MS + MINUTE)
    await maintain(env.deps)
    const path = await env.store.getPath(site.id, 'P')
    const kept = await env.store.listVersions({ id: path?.id as string, email: ALICE })
    expect(kept.map(v => v.id).sort()).toEqual([pathIds[1], pathIds[2]].sort())
  })

  it('a deploy staged and never finalized goes after a day', async () => {
    const { env, alice, site } = await world(0)
    const staged = await json(
      await api(env, alice.key, 'POST', '/api/sites/docs/deploys', {
        manifest: { files: [file('index.html', 'never').meta] },
      })
    )
    env.advance(PENDING_TTL_MS)
    expect((await maintain(env.deps)).marked).toBe(1)
    env.advance(GRACE_MS)
    await maintain(env.deps)
    expect(await env.store.getVersion(site, staged.versionId)).toBeNull()
  })

  it('deletes a replaced rendered home page after the grace', async () => {
    const env = setup()
    const alice = await createUser(env, ALICE)
    await deploy(env, alice.key, 'team', [file('index.html', '<!-- fling:paths -->')])
    await deploy(env, alice.key, 'team', [file('A/index.html', 'a')], { path: 'A' })
    const before = (await env.store.findSite('team'))?.home as string
    await deploy(env, alice.key, 'team', [file('B/index.html', 'b')], { path: 'B' })
    const site = await env.store.findSite('team')
    expect(site?.home).not.toBe(before)
    const key = `sites/${site?.id}/_rendered/${before}.html`
    expect(await env.blobs.get(key)).not.toBeNull()
    expect((await maintain(env.deps)).homes).toBe(0)
    env.advance(GRACE_MS + MINUTE)
    expect((await maintain(env.deps)).homes).toBe(1)
    expect(await env.blobs.get(key)).toBeNull()
    expect(await env.blobs.get(`sites/${site?.id}/_rendered/${site?.home}.html`)).not.toBeNull()
  })
})
