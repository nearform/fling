import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createConfigStore, fileMode, normalizeServerUrl, redactKey } from '../src/config.ts'
import { INSTANCE, runCleanups, SERVER, TEST_KEY, tempDir, tempStore } from './helpers.ts'

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

  it('resolves flag > env > file for the URL (no default) and env > file for the key', async () => {
    const dir = await tempDir()
    const store = createConfigStore({ dir: join(dir, '.fling'), env: {} })
    expect(await store.resolve()).toMatchObject({
      serverUrl: undefined,
      serverUrlSource: 'none',
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

  it('FLING_CONFIG_DIR relocates the file; clearCredentials keeps the server and instance', async () => {
    const dir = await tempDir()
    const store = createConfigStore({ env: { FLING_CONFIG_DIR: dir } })
    expect(store.file).toBe(join(dir, 'config.json'))
    await store.save({ serverUrl: SERVER, instance: INSTANCE, apiKey: 'k', user: { email: 'a@b' } })
    await store.clearCredentials()
    expect(await store.load()).toEqual({ serverUrl: SERVER, instance: INSTANCE })
  })

  it('gives the stored instance only for the server it came from', async () => {
    const { store } = await tempStore()
    await store.save({ serverUrl: `${SERVER}/`, instance: INSTANCE })
    expect((await store.resolve()).instance).toEqual(INSTANCE)
    expect((await store.resolve({ serverUrl: 'https://other.test' })).instance).toBeUndefined()
  })

  it('drops a stored instance it cannot read instead of failing', async () => {
    const { store, dir } = await tempStore()
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, '.fling'), { recursive: true })
    await writeFile(store.file, JSON.stringify({ serverUrl: SERVER, instance: { nope: 1 } }))
    expect(await store.load()).toEqual({ serverUrl: SERVER })
  })

  it('normalizes server addresses', () => {
    expect(normalizeServerUrl('fling.example.test')).toBe('https://fling.example.test')
    expect(normalizeServerUrl(' https://fling.example.test/ ')).toBe('https://fling.example.test')
    expect(normalizeServerUrl('http://localhost:3001')).toBe('http://localhost:3001')
    expect(() => normalizeServerUrl('ftp://x.test')).toThrow(/http/)
  })

  it('ignores blank and unsubstituted extension placeholders in the env', async () => {
    const { store } = await tempStore({
      FLING_URL: ['$', '{user_config.server_url}'].join(''),
      FLING_API_KEY: '  ',
    })
    expect(await store.resolve()).toMatchObject({
      serverUrlSource: 'none',
      apiKeySource: 'none',
    })
  })

  it('never shows a full key', () => {
    expect(redactKey(TEST_KEY)).toBe(`${TEST_KEY.slice(0, 10)}…`)
    expect(redactKey('short')).toBe('****')
    expect(redactKey(undefined)).toBe('-')
  })
})
