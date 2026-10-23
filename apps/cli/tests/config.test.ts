import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createConfigStore, DEFAULT_SERVER_URL, fileMode, redactKey } from '../src/config.ts'
import { runCleanups, TEST_KEY, tempDir, tempStore } from './helpers.ts'

afterEach(runCleanups)

describe('config store', () => {
  it('writes the dir 0700 and the file 0600, and re-tightens on save', async () => {
    const { store } = await tempStore()
    await store.save({ apiKey: TEST_KEY })
    expect(await fileMode(store.file)).toBe(0o600)
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700)
    const { chmod } = await import('node:fs/promises')
    await chmod(store.file, 0o644)
    await store.update({ serverUrl: 'http://x.test' })
    expect(await fileMode(store.file)).toBe(0o600)
  })

  it('resolves flag > env > file > default for the URL and env > file for the key', async () => {
    const dir = await tempDir()
    const store = createConfigStore({ dir: join(dir, '.fling'), env: {} })
    expect(await store.resolve()).toMatchObject({
      serverUrl: DEFAULT_SERVER_URL,
      serverUrlSource: 'default',
      apiKeySource: 'none',
    })
    await store.save({ serverUrl: 'http://file.test/', apiKey: 'file-key' })
    expect(await store.resolve()).toMatchObject({
      serverUrl: 'http://file.test',
      apiKey: 'file-key',
      apiKeySource: 'config',
    })
    const envStore = createConfigStore({
      dir: join(dir, '.fling'),
      env: { FLING_URL: 'http://env.test', FLING_API_KEY: 'env-key' },
    })
    expect(await envStore.resolve()).toMatchObject({
      serverUrl: 'http://env.test',
      apiKey: 'env-key',
      apiKeySource: 'env',
    })
    expect(await envStore.resolve({ serverUrl: 'http://flag.test' })).toMatchObject({
      serverUrl: 'http://flag.test',
      serverUrlSource: 'flag',
    })
  })

  it('FLING_CONFIG_DIR relocates the file; clearCredentials keeps the server URL', async () => {
    const dir = await tempDir()
    const store = createConfigStore({ env: { FLING_CONFIG_DIR: dir } })
    expect(store.file).toBe(join(dir, 'config.json'))
    await store.save({ serverUrl: 'http://x.test', apiKey: 'k', user: { email: 'a@b' } })
    await store.clearCredentials()
    expect(await store.load()).toEqual({ serverUrl: 'http://x.test' })
  })

  it('ignores blank and unsubstituted extension placeholders in the env', async () => {
    const { store } = await tempStore({
      FLING_URL: ['$', '{user_config.server_url}'].join(''),
      FLING_API_KEY: '  ',
    })
    expect(await store.resolve()).toMatchObject({
      serverUrlSource: 'default',
      apiKeySource: 'none',
    })
  })

  it('never shows a full key', () => {
    expect(redactKey(TEST_KEY)).toBe(`${TEST_KEY.slice(0, 10)}…`)
    expect(redactKey('short')).toBe('****')
    expect(redactKey(undefined)).toBe('-')
  })
})
