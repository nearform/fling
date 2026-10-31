/**
 * Thumbnails through the API: who may set one (owners and publishers) and read one (whoever may
 * view the site), what is refused (not a PNG, too large, the wrong size, another version), how it
 * is cached, where the listings report it, and that deleting the site deletes it while archiving
 * keeps it.
 */
import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { thumbnailKey } from '../src/blobs/types.ts'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
const CAROL = 'carol@example.test'
const ADMIN = 'boss@example.test'

function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
/** A grey PNG of the given size, `extra` bytes of padding in a private chunk to make it heavy. */
function png(width = 480, height = 300, extra = 0): Uint8Array<ArrayBuffer> {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 0, 0, 0, 0], 8)
  const rows = Buffer.alloc((width + 1) * height, 0x80)
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      ...(extra ? [chunk('flPd', new Uint8Array(extra))] : []),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', new Uint8Array()),
    ])
  )
}

async function deploy(env: Env, key: string, name: string, text: string, extra: object = {}) {
  const files = [file('index.html', `<h1>${text}</h1>`)]
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...extra,
  })
  const body = await json(res)
  await upload(env, body.uploads, files)
  await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`)
  return body.versionId as string
}

const put = (
  env: Env,
  key: string,
  name: string,
  version: string,
  bytes: Uint8Array<ArrayBuffer>
) =>
  env.app.request(`/api/sites/${name}/thumbnail?version=${version}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'image/png' },
    body: bytes,
  })

const get = (env: Env, key: string, name: string, query = '', headers = {}) =>
  env.app.request(`/api/sites/${name}/thumbnail${query}`, {
    headers: { authorization: `Bearer ${key}`, ...headers },
  })

/** Alice owns `deck` (members-level, live), Bob publishes it, Carol is a member. */
async function world(overrides = {}) {
  const env = setup({ adminEmails: [ADMIN], ...overrides })
  const alice = await createUser(env, ALICE)
  const bob = await createUser(env, BOB)
  const carol = await createUser(env, CAROL)
  const boss = await createUser(env, ADMIN)
  const version = await deploy(env, alice.key, 'deck', 'v1', { access: 'members' })
  await api(env, alice.key, 'PATCH', '/api/sites/deck', { publishers: { emails: [BOB] } })
  return { env, alice, bob, carol, boss, version }
}

describe('PUT /api/sites/:name/thumbnail', () => {
  it('keeps an owner’s thumbnail of the current version, without touching updatedAt', async () => {
    const { env, alice, version } = await world()
    const before = await json(await api(env, alice.key, 'GET', '/api/sites/deck'))
    expect(before.thumbnail).toBeUndefined()
    env.advance(60_000)
    const bytes = png()
    const res = await put(env, alice.key, 'deck', version, bytes)
    expect(res.status).toBe(200)
    const thumbnail = await json(res)
    expect(thumbnail).toEqual({ versionId: version, updatedAt: '2026-01-01T00:01:00.000Z' })
    const after = await json(await api(env, alice.key, 'GET', '/api/sites/deck'))
    expect(after.thumbnail).toEqual(thumbnail)
    expect(after.updatedAt).toBe(before.updatedAt)
    const site = await env.store.findSite('deck')
    expect(await env.blobs.get(thumbnailKey(site?.id ?? ''))).toEqual(bytes)
  })

  it('lets a publisher set it, and nobody else (a refusal is a 404)', async () => {
    const { env, bob, carol, boss, version } = await world()
    expect((await put(env, bob.key, 'deck', version, png())).status).toBe(200)
    expect((await put(env, carol.key, 'deck', version, png())).status).toBe(404)
    // An admin's key reads but changes nothing.
    expect((await put(env, boss.key, 'deck', version, png())).status).toBe(404)
    expect((await put(env, carol.key, 'nope', version, png())).status).toBe(404)
  })

  it('refuses what is not a PNG, too large or the wrong size', async () => {
    const { env, alice, version } = await world()
    const html = Uint8Array.from(Buffer.from('<html>not a picture</html>'.padEnd(64)))
    const cases: [Uint8Array<ArrayBuffer>, number, string][] = [
      [html, 400, 'bad_thumbnail'],
      [png(480, 300).slice(0, 20), 400, 'bad_thumbnail'],
      [png(4000, 10), 400, 'bad_thumbnail'],
      [png(8, 8), 400, 'bad_thumbnail'],
      [png(480, 300, 210 * 1024), 413, 'too_large'],
    ]
    for (const [bytes, status, code] of cases) {
      const res = await put(env, alice.key, 'deck', version, bytes)
      expect(res.status).toBe(status)
      expect((await json(res)).error.code).toBe(code)
    }
    const missing = await env.app.request('/api/sites/deck/thumbnail', {
      method: 'PUT',
      headers: { authorization: `Bearer ${alice.key}` },
      body: png(),
    })
    expect(missing.status).toBe(400)
    expect((await json(await api(env, alice.key, 'GET', '/api/sites/deck'))).thumbnail).toBe(
      undefined
    )
  })

  it('is a 409 for any version but the current one', async () => {
    const { env, alice, version } = await world()
    const next = await deploy(env, alice.key, 'deck', 'v2')
    const res = await put(env, alice.key, 'deck', version, png())
    expect(res.status).toBe(409)
    expect((await json(res)).error.code).toBe('version_changed')
    expect((await put(env, alice.key, 'deck', next, png())).status).toBe(200)
  })
})

describe('GET /api/sites/:name/thumbnail', () => {
  it('serves it to whoever may view the site, cached by when it was taken', async () => {
    const { env, alice, carol, version } = await world()
    expect((await get(env, carol.key, 'deck')).status).toBe(404)
    const bytes = png()
    const { updatedAt } = await json(await put(env, alice.key, 'deck', version, bytes))
    const res = await get(env, carol.key, 'deck')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe('private, no-cache')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
    const etag = res.headers.get('etag') ?? ''
    expect((await get(env, carol.key, 'deck', '', { 'if-none-match': etag })).status).toBe(304)
    const pinned = await get(env, carol.key, 'deck', `?v=${encodeURIComponent(updatedAt)}`)
    expect(pinned.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  })

  it('is a 404 to someone a restricted site leaves out, and served to its audience', async () => {
    const { env, alice, bob, carol, version } = await world()
    const dan = await createUser(env, 'dan@example.test')
    await api(env, alice.key, 'PATCH', '/api/sites/deck', {
      access: 'people',
      audience: { emails: [CAROL] },
    })
    await put(env, bob.key, 'deck', version, png())
    expect((await get(env, carol.key, 'deck')).status).toBe(200)
    expect((await get(env, dan.key, 'deck')).status).toBe(404)
  })

  it('is in the listings: your sites, Shared with me and All sites', async () => {
    const { env, alice, carol, boss, version } = await world()
    await api(env, alice.key, 'PATCH', '/api/sites/deck', {
      access: 'people',
      audience: { emails: [CAROL] },
    })
    const { updatedAt } = await json(await put(env, alice.key, 'deck', version, png()))
    const mine = await json(await api(env, alice.key, 'GET', '/api/sites'))
    expect(mine.sites.find((s: { name: string }) => s.name === 'deck').thumbnail).toEqual({
      versionId: version,
      updatedAt,
    })
    const shared = await json(await api(env, carol.key, 'GET', '/api/shared'))
    expect(shared.sites.find((s: { name: string }) => s.name === 'deck').thumbnail).toEqual({
      updatedAt,
    })
    const all = await json(await api(env, boss.key, 'GET', '/api/admin/sites'))
    expect(all.sites.find((s: { name: string }) => s.name === 'deck').thumbnail).toEqual({
      updatedAt,
    })
  })

  it('outlives archiving, and goes with the site when it is deleted', async () => {
    const { env, alice, version } = await world()
    await put(env, alice.key, 'deck', version, png())
    const site = await env.store.findSite('deck')
    await api(env, alice.key, 'POST', '/api/sites/deck/archive')
    expect((await get(env, alice.key, 'deck')).status).toBe(200)
    // An archived site is offline: no new thumbnail.
    expect((await put(env, alice.key, 'deck', version, png())).status).toBe(409)
    expect((await api(env, alice.key, 'DELETE', '/api/sites/deck')).status).toBe(204)
    expect(await env.blobs.get(thumbnailKey(site?.id ?? ''))).toBeNull()
  })
})
