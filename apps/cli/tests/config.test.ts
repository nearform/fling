import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createConfigStore,
  fileMode,
  matchServer,
  normalizeServerUrl,
  redactKey,
} from '../src/config.ts'
import {
  INSTANCE,
  runCleanups,
  SERVER,
  TEST_KEY,
  tempDir,
  tempStore,
  writeConfig,
} from './helpers.ts'

afterEach(runCleanups)

describe('config store', () => {
  it('writes the dir 0700 and the file 0600, and re-tightens on save', async () => {
    const { store } = await tempStore()
    await store.putServer(SERVER, { apiKey: TEST_KEY })
    expect(await fileMode(store.file)).toBe(0o600)
    expect((await stat(store.dir)).mode & 0o777).toBe(0o700)
    const { chmod } = await import('node:fs/promises')
    await chmod(store.file, 0o644)
    await store.putServer('http://x.test', {})
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
    await store.putServer('http://file.test/', { apiKey: 'file-key' })
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
    await store.putServer(SERVER, { instance: INSTANCE, apiKey: 'k', user: { email: 'a@b' } })
    await store.clearCredentials(SERVER)
    expect(await store.load()).toEqual({
      current: SERVER,
      servers: { [SERVER]: { instance: INSTANCE } },
    })
  })

  it('gives the stored instance only for the server it came from', async () => {
    const { store } = await tempStore()
    await store.putServer(`${SERVER}/`, { instance: INSTANCE })
    expect((await store.resolve()).instance).toEqual(INSTANCE)
    expect((await store.resolve({ serverUrl: 'https://other.test' })).instance).toBeUndefined()
  })

  it('drops a stored instance it cannot read instead of failing', async () => {
    const { store } = await tempStore()
    await writeConfig(store, { serverUrl: SERVER, instance: { nope: 1 } })
    expect(await store.load()).toEqual({ current: SERVER, servers: { [SERVER]: {} } })
  })

  it('reads the single-server shape as one current entry and writes the new shape on save', async () => {
    const { store } = await tempStore()
    const user = { email: 'a@example.test', name: 'A', userSlug: 'a' }
    await writeConfig(store, {
      serverUrl: `${SERVER}/`,
      instance: INSTANCE,
      apiKey: TEST_KEY,
      user,
    })
    const entry = { instance: INSTANCE, apiKey: TEST_KEY, user }
    expect(await store.load()).toEqual({ current: SERVER, servers: { [SERVER]: entry } })
    expect(await store.resolve()).toMatchObject({
      serverUrl: SERVER,
      serverUrlSource: 'config',
      remembered: true,
      apiKey: TEST_KEY,
      user,
    })
    await store.putServer('https://other.test', { apiKey: 'other-key' })
    const { readFile } = await import('node:fs/promises')
    expect(JSON.parse(await readFile(store.file, 'utf8'))).toEqual({
      current: SERVER,
      servers: { [SERVER]: entry, 'https://other.test': { apiKey: 'other-key' } },
    })
  })

  it('leaves out entries it cannot read, and keeps the readable parts of one', async () => {
    const { store } = await tempStore()
    await writeConfig(store, {
      current: 'https://gone.test',
      servers: {
        'not a url at all': { apiKey: 'x' },
        'https://list.test': [1, 2],
        'https://half.test/': { apiKey: 42, user: { email: 'h@example.test' }, future: true },
        [SERVER]: { apiKey: TEST_KEY, instance: { nope: 1 } },
      },
      somethingNew: 1,
    })
    expect(await store.load()).toEqual({
      current: 'https://gone.test',
      servers: {
        'https://half.test': { user: { email: 'h@example.test' } },
        [SERVER]: { apiKey: TEST_KEY },
        'https://gone.test': {},
      },
    })
    await writeConfig(store, { servers: 'nope', current: 7 })
    expect(await store.load()).toEqual({ servers: {} })
    await writeConfig(store, '[1]')
    await expect(store.load()).rejects.toThrow(/is invalid/)
  })

  it('matches a remembered server by address, host, start or parent domain', () => {
    const servers = [
      'https://fling.example.com',
      'http://localhost:47101',
      'https://flingcf.dev.test',
    ]
    expect(matchServer(servers, 'https://fling.example.com/')).toEqual({
      url: 'https://fling.example.com',
      remembered: true,
    })
    expect(matchServer(servers, 'localhost:47101').url).toBe('http://localhost:47101')
    expect(matchServer(servers, 'example.com', { loose: true }).url).toBe(
      'https://fling.example.com'
    )
    expect(matchServer(servers, 'flingcf', { loose: true }).url).toBe('https://flingcf.dev.test')
    // Only `loose` matches by start or parent domain; a full URL is taken as given.
    expect(matchServer(servers, 'example.com')).toEqual({
      url: 'https://example.com',
      remembered: false,
    })
    expect(matchServer(servers, 'https://example.com', { loose: true }).remembered).toBe(false)
    expect(() => matchServer(servers, 'fling', { loose: true })).toThrow(/more than one/)
    expect(() => matchServer(servers, 'ftp://x.test')).toThrow(/not a server address/)
  })

  it('normalizes server addresses', () => {
    expect(normalizeServerUrl('fling.example.test')).toBe('https://fling.example.test')
    expect(normalizeServerUrl(' https://fling.example.test/ ')).toBe('https://fling.example.test')
    expect(normalizeServerUrl('http://localhost:47101')).toBe('http://localhost:47101')
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
