/**
 * Site arrival: the sites' 404 page asks, from the site's own host with the visitor's session,
 * whether a site that was just published is on its way to the edge.
 */
import { describe, expect, it } from 'vitest'
import { api, createUser, type Env, file, json, setup, upload } from './helpers.ts'

async function deploy(env: Env, key: string, name: string, extra = {}) {
  const files = [file('index.html', '<h1>hi</h1>')]
  const res = await api(env, key, 'POST', `/api/sites/${name}/deploys`, {
    manifest: { files: files.map(f => f.meta) },
    ...extra,
  })
  const body = await json(res)
  if (body.status !== 'upload') return body
  await upload(env, body.uploads, files)
  return json(await api(env, key, 'POST', `/api/sites/${name}/deploys/${body.versionId}/finalize`))
}

function ask(env: Env, session: string | null, name: string, origin = `http://${name}.fling.test`) {
  const cookieName = env.config.secureCookies ? '__Host-fling_session' : 'fling_session'
  return env.app.request(`/api/sites/${name}/arrival`, {
    headers: { origin, ...(session ? { cookie: `${cookieName}=${session}` } : {}) },
  })
}

describe('GET /api/sites/:name/arrival', () => {
  it('is true for 30 s after a site it can open changes, from its own host only', async () => {
    const env = setup({ siteScheme: 'http' })
    const alice = await createUser(env, 'alice@example.test')
    await deploy(env, alice.key, 'fresh')
    const res = await ask(env, alice.session, 'fresh')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ arriving: true })
    expect(res.headers.get('access-control-allow-origin')).toBe('http://fresh.fling.test')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('cache-control')).toBe('no-store')
    // Another site's page gets no CORS grant, so its script can't read the answer.
    const other = await ask(env, alice.session, 'fresh', 'http://other.fling.test')
    expect(other.headers.get('access-control-allow-origin')).toBeNull()

    env.advance(31_000)
    expect(await json(await ask(env, alice.session, 'fresh'))).toEqual({ arriving: false })
  })

  it("answers the same for a site the visitor can't open as for no site at all", async () => {
    const env = setup({ siteScheme: 'http' })
    const alice = await createUser(env, 'alice@example.test')
    const bob = await createUser(env, 'bob@example.test')
    await deploy(env, alice.key, 'mine', { access: 'only_me' })
    expect(await json(await ask(env, bob.session, 'mine'))).toEqual({ arriving: false })
    expect(await json(await ask(env, bob.session, 'nothing-here'))).toEqual({ arriving: false })
    // Anonymous: refused before anything is read, still readable by the page.
    const anon = await ask(env, null, 'mine')
    expect(anon.status).toBe(401)
    expect(anon.headers.get('access-control-allow-origin')).toBe('http://mine.fling.test')
  })
})
