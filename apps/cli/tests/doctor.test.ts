import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeResult } from '../src/claude.ts'
import { DESKTOP_EXTENSION_ID } from '../src/claude.ts'
import { runDoctor } from '../src/commands/doctor.ts'
import {
  type Check,
  type DoctorDeps,
  doctorExitCode,
  minimumNode,
  NPM_DIST_TAGS_URL,
  runChecks,
} from '../src/doctor.ts'
import { BIN_NAME, PACKAGE_NAME } from '../src/package-info.ts'
import { UPDATE_COMMAND } from '../src/update-check.ts'
import {
  INSTANCE,
  jsonResponse,
  mockFetch,
  type Route,
  runCleanups,
  SERVER,
  TEST_KEY,
  tempDir,
  tempStore,
  testContext,
} from './helpers.ts'

afterEach(async () => {
  await runCleanups()
  process.exitCode = undefined
})

const V = '0.8.0'
const OTHER = 'https://fling.other.test'
const me = { email: 'ada@example.test', name: 'Ada', picture: null, userSlug: 'ada' }

function fakeClaude(answers: Record<string, Partial<ClaudeResult>>) {
  const calls: string[][] = []
  const run = async (args: readonly string[]) => {
    calls.push([...args])
    const key = Object.keys(answers).find(k => args.join(' ').startsWith(k))
    return { code: 0, stdout: '', stderr: '', ...(key ? answers[key] : {}) }
  }
  return { run, calls }
}

const noClaude = fakeClaude({ '--version': { code: -1 } })

/** A machine: a store signed in to SERVER at release V, an empty PATH, no Claude. */
async function machine(
  options: {
    routes?: Record<string, Route>
    env?: Record<string, string>
    claude?: ReturnType<typeof fakeClaude>
    desktop?: boolean
  } = {}
) {
  const { dir, store } = await tempStore(options.env ?? {})
  await store.putServer(SERVER, { instance: { ...INSTANCE, release: V }, apiKey: TEST_KEY })
  const bin = await tempDir()
  const m = mockFetch({
    'GET /.well-known/fling': () => jsonResponse({ ...INSTANCE, release: V }),
    'GET /api/me': () => jsonResponse(me),
    ...options.routes,
  })
  const deps: DoctorDeps = {
    store,
    fetch: m.fetch,
    env: { PATH: bin, ...options.env },
    runClaude: (options.claude ?? noClaude).run,
    runProgram: async () => ({ code: 1, stdout: '' }),
    nodeVersion: '24.1.0',
    platform: 'darwin',
    home: dir,
    findClaudeDesktop: async () => (options.desktop ? '/Applications/Claude.app' : null),
    version: V,
  }
  return { deps, store, bin, home: dir, m }
}

const byId = (checks: Check[], id: string, server?: string) =>
  checks.find(c => c.id === id && (server === undefined || c.server === server))

describe('fling doctor: the CLI', () => {
  it('reports its version and Node.js against engines', async () => {
    const { deps } = await machine()
    const checks = await runChecks(deps)
    expect(byId(checks, 'cli.version')?.message).toContain(V)
    expect(byId(checks, 'cli.node')).toMatchObject({ status: 'ok' })
    const old = await runChecks({ ...deps, nodeVersion: '18.19.0' })
    expect(byId(old, 'cli.node')).toMatchObject({ status: 'problem' })
    expect(byId(old, 'cli.node')?.fix).toMatch(/Install Node\.js \d+/)
    expect(minimumNode('>=22')?.text).toBe('22')
    expect(minimumNode('^22')).toBeNull()
  })

  it('compares with the latest on npm, and skips that check offline', async () => {
    const newer = await machine({
      routes: { [new URL(NPM_DIST_TAGS_URL).pathname]: () => jsonResponse({ latest: '0.9.0' }) },
    })
    const checks = await runChecks(newer.deps)
    expect(byId(checks, 'cli.latest')).toMatchObject({ status: 'warning', fix: UPDATE_COMMAND })
    expect(byId(checks, 'cli.latest')?.message).toContain(`${PACKAGE_NAME} 0.9.0 is on npm`)

    const same = await machine({
      routes: { [new URL(NPM_DIST_TAGS_URL).pathname]: () => jsonResponse({ latest: V }) },
    })
    expect(byId(await runChecks(same.deps), 'cli.latest')).toMatchObject({ status: 'ok' })

    const offline = await machine()
    const fetchFails: DoctorDeps['fetch'] = async (url, init) => {
      if (url === NPM_DIST_TAGS_URL) throw new TypeError('fetch failed')
      return offline.deps.fetch(url, init)
    }
    expect(byId(await runChecks({ ...offline.deps, fetch: fetchFails }), 'cli.latest')).toBe(
      undefined
    )
  })

  it('says whether `fling` on PATH is this CLI', async () => {
    const { deps, bin } = await machine()
    expect(byId(await runChecks(deps), 'cli.path')).toMatchObject({ status: 'warning' })

    const script = join(await tempDir(), 'cli.js')
    await writeFile(script, '#!/usr/bin/env node\n')
    await chmod(script, 0o755)
    await symlink(script, join(bin, BIN_NAME))
    expect(byId(await runChecks({ ...deps, selfPath: script }), 'cli.path')).toMatchObject({
      status: 'ok',
    })

    // another copy: fine at the same version, a warning at another
    const same = await runChecks({
      ...deps,
      runProgram: async () => ({ code: 0, stdout: `${V}\n` }),
    })
    expect(byId(same, 'cli.path')).toMatchObject({ status: 'ok' })
    const older = await runChecks({
      ...deps,
      runProgram: async () => ({ code: 0, stdout: '0.5.0\n' }),
    })
    expect(byId(older, 'cli.path')).toMatchObject({ status: 'warning' })
    expect(byId(older, 'cli.path')?.message).toContain('version 0.5.0')
    expect(byId(older, 'cli.path')?.fix).toContain(`${BIN_NAME} setup`)
  })
})

describe('fling doctor: the config', () => {
  it('says where it is, and that the file is private', async () => {
    const { deps, store } = await machine()
    const checks = await runChecks(deps)
    expect(byId(checks, 'config.dir')?.message).toContain(store.dir)
    expect(byId(checks, 'config.permissions')).toMatchObject({ status: 'ok' })
  })

  it('flags a config file others can read, with the chmod', async () => {
    const { deps, store } = await machine()
    await chmod(store.file, 0o644)
    const check = byId(await runChecks(deps), 'config.permissions')
    expect(check).toMatchObject({ status: 'problem', fix: `chmod 600 "${store.file}"` })
  })

  it('names FLING_URL and FLING_API_KEY in effect, never their values', async () => {
    const env = { FLING_URL: SERVER, FLING_API_KEY: 'fling_secret_from_env_0123456789' }
    const { deps } = await machine({ env })
    const checks = await runChecks(deps)
    expect(byId(checks, 'config.env.url')).toMatchObject({ status: 'warning' })
    expect(byId(checks, 'config.env.apiKey')).toMatchObject({ status: 'warning' })
    expect(JSON.stringify(checks)).not.toContain(env.FLING_API_KEY)
    expect(JSON.stringify(checks)).not.toContain(TEST_KEY)
  })

  it('says to set up a Fling when there is none', async () => {
    const { store } = await tempStore()
    const { deps } = await machine()
    const check = byId(await runChecks({ ...deps, store }), 'config.dir')
    expect(check).toMatchObject({ status: 'warning' })
    expect(check?.fix).toContain(`${BIN_NAME} setup`)
  })
})

describe('fling doctor: each Fling', () => {
  it('checks the metadata, release, sign-in and capabilities, marking the current one', async () => {
    const { deps } = await machine()
    const checks = await runChecks(deps)
    expect(byId(checks, 'server.metadata', SERVER)?.message).toContain(`${SERVER} (current)`)
    expect(byId(checks, 'server.release', SERVER)).toMatchObject({ status: 'ok' })
    expect(byId(checks, 'server.signedIn', SERVER)?.message).toContain('signed in as ada@')
    expect(byId(checks, 'server.capabilities', SERVER)?.message).toContain('remoteMcp')
    expect(doctorExitCode(checks)).toBe(0)
  })

  it('a newer release says to update', async () => {
    const { deps } = await machine({
      routes: { 'GET /.well-known/fling': () => jsonResponse({ ...INSTANCE, release: '0.9.0' }) },
    })
    const check = byId(await runChecks(deps), 'server.release', SERVER)
    expect(check).toMatchObject({ status: 'warning', fix: UPDATE_COMMAND })
  })

  it('a refused key, or none, says to sign in again', async () => {
    const refused = await machine({
      routes: {
        'GET /api/me': () => jsonResponse({ error: { code: 'unauthorized', message: 'No' } }, 401),
      },
    })
    const checks = await runChecks(refused.deps)
    expect(byId(checks, 'server.signedIn')).toMatchObject({
      status: 'problem',
      fix: `${BIN_NAME} login ${SERVER}`,
    })
    expect(doctorExitCode(checks)).toBe(1)

    const { deps, store } = await machine()
    await store.putServer(OTHER, { instance: { ...INSTANCE, appOrigin: OTHER } })
    const other = byId(await runChecks(deps), 'server.signedIn', OTHER)
    expect(other).toMatchObject({ status: 'problem', fix: `${BIN_NAME} login ${OTHER}` })
  })

  it('an unreachable Fling is a problem', async () => {
    const { deps } = await machine({
      routes: { 'GET /.well-known/fling': () => new Response('nope', { status: 500 }) },
    })
    const checks = await runChecks(deps)
    expect(byId(checks, 'server.metadata')).toMatchObject({ status: 'problem' })
    expect(byId(checks, 'server.signedIn')).toBeUndefined()
  })
})

describe('fling doctor: Claude Code', () => {
  const installed = (plugin: Record<string, unknown>, marketplaces = [{ name: 'fling' }]) =>
    fakeClaude({
      '--version': { stdout: '2.1.0 (Claude Code)' },
      'plugin list': { stdout: JSON.stringify([{ id: 'fling@fling', ...plugin }]) },
      'plugin marketplace list': { stdout: JSON.stringify(marketplaces) },
    })

  it('without claude, says how to get it', async () => {
    const { deps } = await machine()
    const check = byId(await runChecks(deps), 'claudeCode.cli')
    expect(check).toMatchObject({ status: 'warning' })
  })

  it('reports the plugin, its version against the CLI, and the marketplace', async () => {
    const ok = await machine({ claude: installed({ version: V, enabled: true }) })
    const checks = await runChecks(ok.deps)
    expect(byId(checks, 'claudeCode.cli')?.message).toContain('2.1.0')
    expect(byId(checks, 'claudeCode.plugin')).toMatchObject({ status: 'ok' })
    expect(byId(checks, 'claudeCode.marketplace')).toMatchObject({ status: 'ok' })

    const old = await machine({ claude: installed({ version: '0.3.0', enabled: true }, []) })
    const oldChecks = await runChecks(old.deps)
    expect(byId(oldChecks, 'claudeCode.plugin')).toMatchObject({ status: 'warning' })
    expect(byId(oldChecks, 'claudeCode.plugin')?.fix).toContain(
      'claude plugin marketplace update fling && claude plugin update fling@fling'
    )
    expect(byId(oldChecks, 'claudeCode.marketplace')).toMatchObject({ status: 'warning' })
  })

  it('a disabled plugin is a problem; a missing one says to run setup', async () => {
    const off = await machine({ claude: installed({ version: V, enabled: false }) })
    expect(byId(await runChecks(off.deps), 'claudeCode.enabled')).toMatchObject({
      status: 'problem',
      fix: 'claude plugin enable fling@fling',
    })
    const none = await machine({
      claude: fakeClaude({
        '--version': { stdout: '2.1.0' },
        'plugin list': { stdout: '[]' },
      }),
    })
    expect(byId(await runChecks(none.deps), 'claudeCode.plugin')).toMatchObject({
      status: 'warning',
      fix: `${BIN_NAME} setup`,
    })
  })
})

describe('fling doctor: Claude Desktop', () => {
  async function withExtension(home: string, version: string, enabled: boolean) {
    const data = join(home, 'Library', 'Application Support', 'Claude')
    await mkdir(join(data, 'Claude Extensions', DESKTOP_EXTENSION_ID), { recursive: true })
    await mkdir(join(data, 'Claude Extensions Settings'), { recursive: true })
    await writeFile(
      join(data, 'Claude Extensions', DESKTOP_EXTENSION_ID, 'manifest.json'),
      JSON.stringify({ name: 'fling', version })
    )
    await writeFile(
      join(data, 'Claude Extensions Settings', `${DESKTOP_EXTENSION_ID}.json`),
      JSON.stringify({ isEnabled: enabled })
    )
  }

  it('says nothing without Claude Desktop, and how to install the extension when missing', async () => {
    const without = await machine()
    expect((await runChecks(without.deps)).some(c => c.area === 'claudeDesktop')).toBe(false)
    const { deps } = await machine({ desktop: true })
    expect(byId(await runChecks(deps), 'claudeDesktop.extension')).toMatchObject({
      status: 'warning',
      fix: expect.stringContaining(`${BIN_NAME} setup`),
    })
  })

  it('reports the installed version, an older one, and a disabled extension', async () => {
    const ok = await machine({ desktop: true })
    await withExtension(ok.home, V, true)
    expect(byId(await runChecks(ok.deps), 'claudeDesktop.extension')?.message).toContain(`(${V})`)

    const old = await machine({ desktop: true })
    await withExtension(old.home, '0.5.0', false)
    const checks = await runChecks(old.deps)
    expect(byId(checks, 'claudeDesktop.extension')).toMatchObject({ status: 'warning' })
    expect(byId(checks, 'claudeDesktop.enabled')).toMatchObject({ status: 'problem' })
  })
})

describe('fling doctor: the command', () => {
  it('--json prints the checks; exit code 1 on a problem; nothing is written', async () => {
    const { deps, store } = await machine({
      routes: {
        'GET /api/me': () => jsonResponse({ error: { code: 'unauthorized', message: 'No' } }, 401),
      },
    })
    const before = JSON.stringify(await store.load())
    const { ctx, out } = await testContext({ store, json: true })
    await runDoctor(ctx, deps)
    const data = JSON.parse(out.content())
    expect(data.ok).toBe(false)
    expect(data.checks.find((c: Check) => c.id === 'server.signedIn').status).toBe('problem')
    expect(process.exitCode).toBe(1)
    expect(JSON.stringify(await store.load())).toBe(before)
    // only reads
    const { m } = await machine()
    await runChecks({ ...deps, fetch: m.fetch })
    expect(m.calls.every(c => c.method === 'GET')).toBe(true)
  })

  it('prints one line per check, with the fix', async () => {
    const { deps, store } = await machine({ claude: fakeClaude({ '--version': { code: -1 } }) })
    const { ctx, out } = await testContext({ store })
    await runDoctor(ctx, deps)
    const text = out.content()
    expect(text).toMatch(/✔ .*CLI 0\.8\.0/)
    expect(text).toMatch(/▲ Claude Code not found.* — fix: /)
    expect(process.exitCode).toBeUndefined()
  })
})
