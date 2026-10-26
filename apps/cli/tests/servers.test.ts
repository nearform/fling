/** Several servers: login keeps the others, `use` switches, --server / FLING_URL pick a key, logout. */
import { afterEach, describe, expect, it } from 'vitest'
import { runLogin, runLogout, runUse, runWhoami } from '../src/commands/auth.ts'
import { runSetup } from '../src/commands/setup.ts'
import { createConfigStore } from '../src/config.ts'
import { createContext, requireClient } from '../src/context.ts'
import { createMemoryLogger } from '../src/utils/logger.ts'
import { createMemoryOutput } from '../src/utils/output.ts'
import {
  captureError,
  headersOf,
  INSTANCE,
  jsonResponse,
  mockFetch,
  runCleanups,
  SERVER,
  TEST_KEY,
  tempStore,
  testContext,
  writeConfig,
} from './helpers.ts'

afterEach(async () => {
  await runCleanups()
  process.exitCode = undefined
})

const OTHER = 'https://fling.other.test'
const OTHER_KEY = 'fling_other_0123456789abcdefghijklmnopqrstuvwxyz'
const OTHER_INSTANCE = { ...INSTANCE, name: 'Other Fling', appOrigin: OTHER }
const users: Record<string, { email: string; name: string; userSlug: string }> = {
  [SERVER]: { email: 'ada@example.test', name: 'Ada', userSlug: 'ada' },
  [OTHER]: { email: 'ada@other.test', name: 'Ada O', userSlug: 'ada-o' },
}

/** Both servers answer /.well-known/fling and /api/me, by origin. */
function servers() {
  return mockFetch({
    'GET /.well-known/fling': url => jsonResponse(url.origin === OTHER ? OTHER_INSTANCE : INSTANCE),
    'GET /api/me': url => jsonResponse({ ...users[url.origin], picture: null }),
  })
}

/** A stand-in for the browser: completes the sign-in with `key`. */
function browserGiving(key: string) {
  return async (url: string) => {
    const auth = new URL(url)
    const target = new URL(auth.searchParams.get('redirect_uri') ?? '')
    target.searchParams.set('state', auth.searchParams.get('state') ?? '')
    target.searchParams.set('key', key)
    void fetch(target).then(r => r.text())
  }
}

/** SERVER (current) and OTHER, both signed in. */
async function twoServers() {
  const { store, dir } = await tempStore()
  await store.putServer(SERVER, { instance: INSTANCE, apiKey: TEST_KEY, user: users[SERVER] })
  await store.putServer(OTHER, { instance: OTHER_INSTANCE, apiKey: OTHER_KEY, user: users[OTHER] })
  return { store, dir }
}

describe('several servers', () => {
  it('login to a second server keeps the first and makes the second current', async () => {
    const { store } = await tempStore()
    await writeConfig(store, { serverUrl: SERVER, instance: INSTANCE, apiKey: TEST_KEY })
    const m = servers()
    const { ctx } = await testContext({ store, fetch: m.fetch })
    ctx.open = browserGiving(OTHER_KEY)
    await runLogin(ctx, 'fling.other.test')
    const config = await store.load()
    expect(config.current).toBe(OTHER)
    expect(config.servers[SERVER]).toMatchObject({ apiKey: TEST_KEY, instance: INSTANCE })
    expect(config.servers[OTHER]).toMatchObject({
      apiKey: OTHER_KEY,
      instance: OTHER_INSTANCE,
      user: { email: users[OTHER]?.email },
    })
  })

  it('use lists the servers and switches between them by address or host', async () => {
    const { store } = await twoServers()
    const list = await testContext({ store, json: true })
    await runUse(list.ctx)
    const listed = JSON.parse(list.out.content())
    expect(listed.current).toBe(SERVER)
    expect(listed.servers).toEqual(
      expect.arrayContaining([
        {
          url: SERVER,
          current: true,
          instance: 'Example Fling',
          email: 'ada@example.test',
          signedIn: true,
        },
        {
          url: OTHER,
          current: false,
          instance: 'Other Fling',
          email: 'ada@other.test',
          signedIn: true,
        },
      ])
    )

    const human = await testContext({ store })
    await runUse(human.ctx)
    expect(human.out.content()).toMatch(/\* {2}http:\/\/server\.test\s+Example Fling\s+ada@example/)

    const { ctx } = await testContext({ store })
    await runUse(ctx, 'other.test')
    expect((await store.resolve()).serverUrl).toBe(OTHER)
    expect((await store.resolve()).apiKey).toBe(OTHER_KEY)
    await runUse(ctx, SERVER)
    expect((await store.load()).current).toBe(SERVER)

    const e = await captureError(runUse(ctx, 'https://unknown.test'))
    expect(e.message).toBe('Not signed in to https://unknown.test on this computer')
    expect((await store.load()).current).toBe(SERVER)
  })

  it('--server and FLING_URL pick a remembered server and its key; FLING_API_KEY still wins', async () => {
    const { store } = await twoServers()
    const m = servers()
    const viaFlag = await createContext({ store, server: 'fling.other.test', fetch: m.fetch })
    expect(viaFlag.config).toMatchObject({ serverUrl: OTHER, apiKey: OTHER_KEY, current: SERVER })
    await requireClient(viaFlag).request('GET', '/api/me')
    expect(m.calls.at(-1)?.url.origin).toBe(OTHER)
    expect(headersOf(m.calls, m.calls.length - 1).Authorization).toBe(`Bearer ${OTHER_KEY}`)

    const envStore = createConfigStore({ dir: store.dir, env: { FLING_URL: OTHER } })
    expect(await envStore.resolve()).toMatchObject({
      serverUrl: OTHER,
      serverUrlSource: 'env',
      apiKey: OTHER_KEY,
      instance: OTHER_INSTANCE,
    })
    // The flag beats the env; an unknown server has no stored key.
    expect(await envStore.resolve({ serverUrl: SERVER })).toMatchObject({ apiKey: TEST_KEY })
    expect(await envStore.resolve({ serverUrl: 'https://new.test' })).toMatchObject({
      serverUrl: 'https://new.test',
      remembered: false,
      apiKeySource: 'none',
    })
    const keyed = createConfigStore({
      dir: store.dir,
      env: { FLING_URL: OTHER, FLING_API_KEY: 'env-key' },
    })
    expect(await keyed.resolve()).toMatchObject({ serverUrl: OTHER, apiKey: 'env-key' })
    // None of this changed the current server.
    expect((await store.load()).current).toBe(SERVER)
  })

  it('whoami says which server is current', async () => {
    const { store } = await twoServers()
    const m = servers()
    const log = createMemoryLogger()
    const out = createMemoryOutput(false)
    const ctx = await createContext({ store, server: OTHER, fetch: m.fetch, log, out })
    await runWhoami(ctx)
    expect(out.content()).toContain(`(from --server; current: ${SERVER})`)
    const json = await testContext({ store, fetch: m.fetch, json: true })
    await runWhoami(json.ctx)
    expect(JSON.parse(json.out.content())).toMatchObject({ serverUrl: SERVER, current: SERVER })
  })

  it('logout of another server forgets it; logout of the current one keeps it, signed out', async () => {
    const { store } = await twoServers()
    const { ctx, log } = await testContext({ store })
    await runLogout(ctx, 'other.test')
    expect(Object.keys((await store.load()).servers)).toEqual([SERVER])
    expect(log.lines.join('\n')).toContain(`Revoke it on the server under Connections at ${OTHER}`)

    const again = await testContext({ store })
    await runLogout(again.ctx)
    expect(await store.load()).toEqual({
      current: SERVER,
      servers: { [SERVER]: { instance: INSTANCE } },
    })
    const twice = await testContext({ store })
    await runLogout(twice.ctx)
    expect(twice.log.lines.join('\n')).toMatch(/Not logged in — nothing to do/)
  })

  it('setup <url> with a working stored key makes that server current without signing in', async () => {
    const { store } = await twoServers()
    const { ctx, out } = await testContext({ store, fetch: servers().fetch, json: true })
    ctx.open = async () => {
      throw new Error('no browser expected')
    }
    await runSetup(
      ctx,
      { yes: true, url: OTHER },
      {
        runClaude: async () => ({ code: -1, stdout: '', stderr: '' }),
        findClaudeDesktop: async () => null,
      }
    )
    expect(JSON.parse(out.content()).login).toBe('already')
    expect((await store.load()).current).toBe(OTHER)
  })
})
