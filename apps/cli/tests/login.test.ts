/** Login handoff: real loopback server, a simulated browser redirect, stubbed `open`. */
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildAuthUrl,
  CALLBACK_PORT_END,
  CALLBACK_PORT_START,
  loginFlow,
  parseCallback,
  startCallbackServer,
} from '../src/auth.ts'
import { createMemoryLogger } from '../src/utils/logger.ts'
import {
  captureError,
  INSTANCE,
  instanceRoute,
  jsonResponse,
  mockFetch,
  runCleanups,
  SERVER,
  TEST_KEY,
  tempStore,
} from './helpers.ts'

afterEach(runCleanups)

const ME = {
  email: 'ada.lovelace@example.test',
  name: 'Ada',
  picture: null,
  userSlug: 'ada-lovelace',
}

/** A stand-in for the browser: follow `redirect_uri` with `params` (`state` echoed unless given). */
function browser(params: Record<string, string>, opts: { echoState?: boolean } = {}) {
  const seen: string[] = []
  const open = async (url: string) => {
    seen.push(url)
    const auth = new URL(url)
    const target = new URL(auth.searchParams.get('redirect_uri') ?? '')
    if (opts.echoState !== false)
      target.searchParams.set('state', auth.searchParams.get('state') ?? '')
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v)
    void fetch(target).then(r => r.text())
  }
  return { open, seen }
}

describe('buildAuthUrl', () => {
  it('points at /auth/cli with redirect_uri, hostname and state', () => {
    const url = new URL(
      buildAuthUrl(`${SERVER}/`, 'http://127.0.0.1:8765/callback', 'my-mac', 'st4te')
    )
    expect(url.origin + url.pathname).toBe(`${SERVER}/auth/cli`)
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8765/callback')
    expect(url.searchParams.get('hostname')).toBe('my-mac')
    expect(url.searchParams.get('state')).toBe('st4te')
  })
})

describe('parseCallback', () => {
  const u = (q: string) => new URL(`http://127.0.0.1:8765/callback?${q}`)
  it('extracts the key', () => {
    expect(parseCallback(u('key=k1&state=s'), 's')).toEqual({ ok: true, key: 'k1' })
    expect(parseCallback(u('key=k1'), 's')).toEqual({ ok: true, key: 'k1' })
  })
  it('rejects error, mismatched state and missing key', () => {
    expect(parseCallback(u('error=access_denied'), 's')).toMatchObject({
      ok: false,
      message: /access_denied/,
    })
    expect(parseCallback(u('key=k1&state=other'), 's')).toMatchObject({
      ok: false,
      message: /state mismatch/,
    })
    expect(parseCallback(u('state=s'), 's')).toMatchObject({ ok: false, message: /missing.*key/ })
  })
})

describe('callback server', () => {
  it('listens on 127.0.0.1 within 8765–8770 and serves a self-closing page without the key', async () => {
    const cb = await startCallbackServer({ state: 's', timeoutMs: 5_000 })
    try {
      expect(cb.port).toBeGreaterThanOrEqual(CALLBACK_PORT_START)
      expect(cb.port).toBeLessThanOrEqual(CALLBACK_PORT_END)
      const res = await fetch(`${cb.url}?key=${TEST_KEY}&state=s`)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('window.close()')
      expect(html).not.toContain(TEST_KEY)
      await expect(cb.result).resolves.toEqual({ key: TEST_KEY })
    } finally {
      cb.close()
    }
  })

  it('moves to the next port when one is taken; 404s other paths; rejects ?error=', async () => {
    const a = await startCallbackServer({ timeoutMs: 5_000 })
    const b = await startCallbackServer({ timeoutMs: 5_000 })
    try {
      expect(b.port).toBe(a.port + 1)
      expect((await fetch(`http://127.0.0.1:${a.port}/other`)).status).toBe(404)
      const res = await fetch(`${a.url}?error=domain_not_allowed`)
      expect(res.status).toBe(400)
      expect((await captureError(a.result)).message).toMatch(/domain_not_allowed/)
    } finally {
      a.close()
      b.close()
    }
  })

  it('times out', async () => {
    const cb = await startCallbackServer({ timeoutMs: 20 })
    try {
      expect((await captureError(cb.result)).message).toMatch(/Timed out/)
    } finally {
      cb.close()
    }
  })
})

describe('loginFlow', () => {
  it('verifies the key with /api/me and stores it 0600', async () => {
    const { store } = await tempStore()
    const m = mockFetch({ ...instanceRoute, 'GET /api/me': () => jsonResponse(ME) })
    const b = browser({ key: TEST_KEY })
    const log = createMemoryLogger()
    const result = await loginFlow({
      serverUrl: SERVER,
      store,
      log,
      open: b.open,
      fetch: m.fetch,
      hostname: 'box',
    })
    expect(result.user.email).toBe(ME.email)
    expect(result.keyPrefix).not.toBe(TEST_KEY)
    expect(new URL(b.seen[0] ?? '').searchParams.get('hostname')).toBe('box')
    const me = m.calls.find(c => c.url.pathname === '/api/me')
    expect((me?.init.headers as Record<string, string> | undefined)?.Authorization).toBe(
      `Bearer ${TEST_KEY}`
    )
    expect(result.instance).toEqual(INSTANCE)
    expect(await store.load()).toEqual({
      serverUrl: SERVER,
      instance: INSTANCE,
      apiKey: TEST_KEY,
      user: { email: ME.email, name: ME.name, userSlug: ME.userSlug },
    })
    expect(log.lines.join('\n')).not.toContain(TEST_KEY)
  })

  it('fails (and stores nothing) when the key is rejected or the state does not match', async () => {
    const { store } = await tempStore()
    const m = mockFetch({
      ...instanceRoute,
      'GET /api/me': () => jsonResponse({ error: { code: 'unauthorized', message: 'nope' } }, 401),
    })
    const e = await captureError(
      loginFlow({
        serverUrl: SERVER,
        store,
        log: createMemoryLogger(),
        open: browser({ key: 'k' }).open,
        fetch: m.fetch,
      })
    )
    expect(e.exitCode).toBe(2)

    const bad = browser({ key: 'k', state: 'forged' })
    const e2 = await captureError(
      loginFlow({
        serverUrl: SERVER,
        store,
        log: createMemoryLogger(),
        open: bad.open,
        fetch: m.fetch,
      })
    )
    expect(e2.message).toMatch(/state mismatch/)
    expect(await store.load()).toEqual({})
  })

  it('refuses a server that is not a Fling, before opening the browser', async () => {
    const { store } = await tempStore()
    const b = browser({ key: TEST_KEY })
    const e = await captureError(
      loginFlow({
        serverUrl: 'https://example.test',
        store,
        log: createMemoryLogger(),
        open: b.open,
        fetch: mockFetch({ 'GET /.well-known/fling': () => jsonResponse({ hello: 1 }) }).fetch,
      })
    )
    expect(e.message).toBe(
      'https://example.test does not look like a Fling server (no valid https://example.test/.well-known/fling)'
    )
    expect(b.seen).toHaveLength(0)
    expect(await store.load()).toEqual({})
  })
})
