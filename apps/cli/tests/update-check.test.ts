import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RELEASE_HEADER } from '@fling/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { updateCheckSilenced } from '../src/config.ts'
import { requireClient } from '../src/context.ts'
import { BIN_NAME, PACKAGE_NAME } from '../src/package-info.ts'
import { whoami } from '../src/sites.ts'
import {
  NOTIFY_EVERY_MS,
  newerRelease,
  noticeAfterCommand,
  UPDATE_STATE_FILE,
  type UpdateCheckInput,
  updateNotice,
} from '../src/update-check.ts'
import { INSTANCE, mockFetch, runCleanups, SERVER, tempStore, testContext } from './helpers.ts'

afterEach(runCleanups)

const OTHER = 'https://fling.other.test'
const NOW = new Date('2026-11-03T10:00:00.000Z')
const later = (ms: number) => new Date(NOW.getTime() + ms)

async function input(overrides: Partial<UpdateCheckInput> = {}): Promise<UpdateCheckInput> {
  const { store } = await tempStore()
  return {
    store,
    serverUrl: SERVER,
    release: '0.8.0',
    json: false,
    stderrTTY: true,
    silenced: false,
    now: NOW,
    version: '0.5.0',
    ...overrides,
  }
}

describe('newerRelease', () => {
  it('is the release when it is a newer semver, else null', () => {
    expect(newerRelease('0.8.0', '0.5.0')).toBe('0.8.0')
    expect(newerRelease('1.0.0', '0.9.9')).toBe('1.0.0')
    expect(newerRelease('0.10.0', '0.9.0')).toBe('0.10.0')
    expect(newerRelease('0.5.1', '0.5.0')).toBe('0.5.1')
    expect(newerRelease('0.5.0', '0.5.0')).toBeNull()
    expect(newerRelease('0.4.9', '0.5.0')).toBeNull()
    expect(newerRelease('0.9.0', '0.10.0')).toBeNull()
  })

  it('orders pre-releases before their release', () => {
    expect(newerRelease('0.8.0', '0.8.0-rc.1')).toBe('0.8.0')
    expect(newerRelease('0.8.0-rc.2', '0.8.0-rc.1')).toBe('0.8.0-rc.2')
    expect(newerRelease('0.8.0-rc.10', '0.8.0-rc.9')).toBe('0.8.0-rc.10')
    expect(newerRelease('0.8.0-rc.1', '0.8.0')).toBeNull()
    expect(newerRelease('0.8.0+build.5', '0.8.0')).toBeNull()
  })

  it('says nothing about a missing or malformed release', () => {
    for (const release of [undefined, null, '', 'latest', '0.8', '0.8.0.1', '01.2.3', 8, {}])
      expect(newerRelease(release, '0.5.0')).toBeNull()
    expect(newerRelease('0.8.0', 'not-a-version')).toBeNull()
  })
})

describe('updateNotice', () => {
  it('says a newer release is out, with the update command', async () => {
    const line = await updateNotice(await input())
    expect(line).toBe(
      `Fling 0.8.0 is out (this CLI is 0.5.0). Update: npm i -g ${PACKAGE_NAME}@latest && ${BIN_NAME} setup`
    )
  })

  it('says nothing when the server is older, the same, or its release is unknown', async () => {
    for (const release of ['0.4.0', '0.5.0', undefined, 'garbage'])
      expect(await updateNotice(await input({ release }))).toBeNull()
  })

  it('tells about each server at most once a day, recording when in the config dir', async () => {
    const base = await input()
    expect(await updateNotice(base)).not.toBeNull()
    const state = JSON.parse(await readFile(join(base.store.dir, UPDATE_STATE_FILE), 'utf8'))
    expect(state.notified[SERVER]).toBe(NOW.toISOString())

    expect(await updateNotice({ ...base, now: later(60_000) })).toBeNull()
    expect(await updateNotice({ ...base, now: later(NOTIFY_EVERY_MS - 1) })).toBeNull()
    // another server has its own day
    expect(await updateNotice({ ...base, serverUrl: OTHER, now: later(60_000) })).not.toBeNull()
    expect(await updateNotice({ ...base, now: later(NOTIFY_EVERY_MS) })).not.toBeNull()
    expect(await updateNotice({ ...base, now: later(NOTIFY_EVERY_MS + 60_000) })).toBeNull()
  })

  it('records nothing when it says nothing', async () => {
    const base = await input({ release: '0.5.0' })
    expect(await updateNotice(base)).toBeNull()
    expect(await updateNotice({ ...base, release: '0.8.0' })).not.toBeNull()
  })

  it('is silent under --json, off a terminal, when silenced, and without a server', async () => {
    for (const overrides of [
      { json: true },
      { stderrTTY: false },
      { silenced: true },
      { serverUrl: undefined },
    ]) {
      const base = await input(overrides)
      expect(await updateNotice(base)).toBeNull()
      // and none of these uses up the day
      expect(await updateNotice({ ...base, ...(await input()), store: base.store })).not.toBeNull()
    }
  })

  it('a broken state file is started afresh, never an error', async () => {
    const base = await input()
    await updateNotice(base)
    await writeFile(join(base.store.dir, UPDATE_STATE_FILE), '{not json')
    expect(await updateNotice({ ...base, now: later(60_000) })).not.toBeNull()
  })
})

describe('updateCheckSilenced', () => {
  it('is on when FLING_NO_UPDATE_CHECK or CI is set', () => {
    expect(updateCheckSilenced({})).toBe(false)
    expect(updateCheckSilenced({ FLING_NO_UPDATE_CHECK: '1' })).toBe(true)
    expect(updateCheckSilenced({ CI: 'true' })).toBe(true)
    expect(updateCheckSilenced({ CI: '', FLING_NO_UPDATE_CHECK: ' ' })).toBe(false)
  })
})

describe('noticeAfterCommand', () => {
  async function ctxWith(release: string | undefined, json = false) {
    const { store } = await tempStore()
    await store.putServer(SERVER, { instance: { ...INSTANCE, release } })
    return testContext({ store, json })
  }

  it('warns on stderr from the stored metadata of the server the command used', async () => {
    const { ctx, log, out } = await ctxWith('0.8.0')
    await noticeAfterCommand(ctx, undefined, { stderrTTY: true, silenced: false, version: '0.5.0' })
    expect(log.lines.join('\n')).toContain('Fling 0.8.0 is out (this CLI is 0.5.0)')
    expect(out.content()).toBe('')
  })

  it('reads the metadata again: a command may have refreshed it', async () => {
    const { ctx, log } = await ctxWith('0.5.0')
    await ctx.store.putServer(SERVER, { instance: { ...INSTANCE, release: '0.9.0' } })
    await noticeAfterCommand(ctx, undefined, { stderrTTY: true, silenced: false, version: '0.5.0' })
    expect(log.lines.join('\n')).toContain('Fling 0.9.0 is out')
  })

  it('says nothing under --json, off a terminal or when silenced', async () => {
    const opts = { stderrTTY: true, silenced: false, version: '0.5.0' }
    for (const [json, extra] of [
      [true, {}],
      [false, { stderrTTY: false }],
      [false, { silenced: true }],
    ] as const) {
      const { ctx, log } = await ctxWith('0.8.0', json)
      await noticeAfterCommand(ctx, undefined, { ...opts, ...extra })
      expect(log.lines).toEqual([])
    }
  })
})

describe('Fling-Release', () => {
  const meWith = (release?: string) => () =>
    new Response(
      JSON.stringify({ email: 'ada@example.test', name: 'Ada', picture: null, userSlug: 'ada' }),
      {
        headers: {
          'Content-Type': 'application/json',
          ...(release ? { [RELEASE_HEADER]: release } : {}),
        },
      }
    )

  async function signedInAt(release: string) {
    const { store } = await tempStore()
    await store.putServer(SERVER, {
      instance: { ...INSTANCE, release },
      apiKey: 'fling_k_0123456789abcdef',
    })
    return store
  }

  it('a response naming another release updates the stored one, and the hint follows', async () => {
    const store = await signedInAt('0.5.0')
    const m = mockFetch({ 'GET /api/me': meWith('0.9.0') })
    const { ctx, log } = await testContext({ store, fetch: m.fetch })
    await whoami(requireClient(ctx))
    const stored = (await store.resolve()).instance
    expect(stored?.release).toBe('0.9.0')
    // the rest of the metadata is kept, not refetched
    expect(stored?.name).toBe(INSTANCE.name)
    expect(m.calls.map(c => c.url.pathname)).toEqual(['/api/me'])
    await noticeAfterCommand(ctx, undefined, { stderrTTY: true, silenced: false, version: '0.5.0' })
    expect(log.lines.join('\n')).toContain('Fling 0.9.0 is out (this CLI is 0.5.0)')
  })

  it('the same release, or none, writes nothing; the throttle still holds', async () => {
    for (const header of ['0.5.0', undefined]) {
      const store = await signedInAt('0.5.0')
      const before = await readFile(store.file, 'utf8')
      const m = mockFetch({ 'GET /api/me': meWith(header) })
      const { ctx } = await testContext({ store, fetch: m.fetch })
      await whoami(requireClient(ctx))
      expect(await readFile(store.file, 'utf8')).toBe(before)
    }
    const store = await signedInAt('0.5.0')
    const m = mockFetch({ 'GET /api/me': meWith('0.9.0') })
    const { ctx, log } = await testContext({ store, fetch: m.fetch })
    const opts = { stderrTTY: true, silenced: false, version: '0.5.0', now: NOW }
    await whoami(requireClient(ctx))
    await noticeAfterCommand(ctx, undefined, opts)
    await whoami(requireClient(ctx))
    await noticeAfterCommand(ctx, undefined, { ...opts, now: later(60_000) })
    expect(log.lines.filter(l => l.includes('is out'))).toHaveLength(1)
  })
})
