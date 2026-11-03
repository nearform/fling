import { REPO_SLUG, REPO_URL } from '@fling/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { type ClaudeResult, extensionSources, releaseExtensionUrl } from '../src/claude.ts'
import { runSetup } from '../src/commands/setup.ts'
import { VERSION } from '../src/package-info.ts'
import {
  INSTANCE,
  jsonResponse,
  loggedInStore,
  mockFetch,
  runCleanups,
  SERVER,
  TEST_KEY,
  tempStore,
  testContext,
} from './helpers.ts'

afterEach(async () => {
  await runCleanups()
  process.exitCode = undefined
})

const me = { email: 'ada@example.test', name: 'Ada', picture: null, userSlug: 'ada' }

/** A fake `claude` that answers by subcommand and records every call. */
function fakeClaude(answers: Record<string, Partial<ClaudeResult>>) {
  const calls: string[][] = []
  const run = async (args: readonly string[]) => {
    calls.push([...args])
    const key = Object.keys(answers).find(k => args.join(' ').startsWith(k))
    return { code: 0, stdout: '', stderr: '', ...(key ? answers[key] : {}) }
  }
  return { run, calls }
}

async function setupCtx() {
  const m = mockFetch({ 'GET /api/me': () => jsonResponse(me) })
  return testContext({ store: await loggedInStore(), fetch: m.fetch, json: true })
}

describe('fling setup', () => {
  it('installs the Claude Code plugin from the repository marketplace', async () => {
    const claude = fakeClaude({
      '--version': { stdout: '2.1.0 (Claude Code)' },
      'plugin list': { stdout: '[]' },
    })
    const { ctx, out } = await setupCtx()
    await runSetup(
      ctx,
      { yes: true },
      { runClaude: claude.run, findClaudeDesktop: async () => null }
    )
    expect(claude.calls).toContainEqual([
      'plugin',
      'install',
      'fling',
      '--marketplace',
      REPO_SLUG,
      '-s',
      'user',
    ])
    expect(JSON.parse(out.content())).toEqual({
      login: 'already',
      claudeCode: 'done',
      claudeDesktop: 'missing',
    })
  })

  /** `claude plugin list --json` saying the plugin is installed at each version in turn. */
  function installedAt(...versions: string[]) {
    const lists = versions.map(version =>
      JSON.stringify([{ id: 'fling@fling', version, scope: 'user' }])
    )
    return fakeClaude({
      '--version': { stdout: '2.1.0 (Claude Code)' },
      get 'plugin list'() {
        return { stdout: lists.length > 1 ? lists.shift() : lists[0] }
      },
    })
  }

  it('refreshes an installed plugin, says from and to which version, and to restart', async () => {
    const claude = installedAt('0.3.0', '0.8.0')
    const { ctx, out, log } = await setupCtx()
    ctx.interactive = true
    ctx.confirm = async () => {
      throw new Error('refreshing an installed plugin asks nothing')
    }
    await runSetup(ctx, {}, { runClaude: claude.run, findClaudeDesktop: async () => null })
    const marketplace = claude.calls.findIndex(
      c => c.join(' ') === 'plugin marketplace update fling'
    )
    const update = claude.calls.findIndex(c => c.join(' ') === 'plugin update fling@fling -s user')
    expect(marketplace).toBeGreaterThan(-1)
    expect(update).toBeGreaterThan(marketplace)
    const said = log.lines.join('\n')
    expect(said).toContain('Claude Code plugin fling updated from 0.3.0 to 0.8.0')
    expect(said).toMatch(/Restart Claude Code/)
    expect(JSON.parse(out.content()).claudeCode).toBe('updated')
  })

  it('says an installed plugin that is already the latest is up to date, with no restart', async () => {
    const claude = installedAt('0.8.0')
    const { ctx, out, log } = await setupCtx()
    await runSetup(
      ctx,
      { yes: true },
      { runClaude: claude.run, findClaudeDesktop: async () => null }
    )
    expect(claude.calls).toContainEqual(['plugin', 'marketplace', 'update', 'fling'])
    expect(claude.calls).toContainEqual(['plugin', 'update', 'fling@fling', '-s', 'user'])
    const said = log.lines.join('\n')
    expect(said).toContain('Claude Code plugin fling is up to date')
    expect(said).not.toMatch(/Restart Claude Code/)
    expect(JSON.parse(out.content()).claudeCode).toBe('already')
  })

  it('a failed refresh is reported but does not fail setup', async () => {
    for (const failing of ['plugin marketplace update', 'plugin update']) {
      const claude = fakeClaude({
        '--version': { stdout: '2.1.0 (Claude Code)' },
        'plugin list': {
          stdout: JSON.stringify([{ id: 'fling@fling', version: '0.3.0', scope: 'user' }]),
        },
        [failing]: { code: 1, stderr: 'offline' },
      })
      const { ctx, out, log } = await setupCtx()
      await runSetup(
        ctx,
        { yes: true },
        { runClaude: claude.run, findClaudeDesktop: async () => null }
      )
      expect(log.lines.join('\n')).toMatch(
        /Could not update the (marketplace|Fling plugin): offline/
      )
      expect(log.lines.join('\n')).toContain('the installed plugin (0.3.0) is unchanged')
      expect(JSON.parse(out.content()).claudeCode).toBe('already')
      expect(process.exitCode).toBeUndefined()
    }
  })

  it('without claude, skips with a hint; a failed install sets exit code 1', async () => {
    const missing = fakeClaude({ '--version': { code: -1 } })
    const a = await setupCtx()
    await runSetup(
      a.ctx,
      { yes: true },
      { runClaude: missing.run, findClaudeDesktop: async () => null }
    )
    expect(JSON.parse(a.out.content()).claudeCode).toBe('missing')
    expect(a.log.lines.join('\n')).toContain(`/plugin marketplace add ${REPO_SLUG}`)
    expect(process.exitCode).toBeUndefined()

    const broken = fakeClaude({
      '--version': { stdout: '2.1.0' },
      'plugin list': { stdout: '[]' },
      'plugin install': { code: 1, stderr: 'network down' },
    })
    const b = await setupCtx()
    await runSetup(
      b.ctx,
      { yes: true },
      { runClaude: broken.run, findClaudeDesktop: async () => null }
    )
    expect(b.log.lines.join('\n')).toMatch(/Could not install the Fling plugin: network down/)
    expect(process.exitCode).toBe(1)
  })

  it("opens the extension of the CLI's version: the server's when it runs that release", async () => {
    const claude = fakeClaude({ '--version': { code: -1 } })
    const { store } = await tempStore()
    await store.putServer(SERVER, {
      instance: { ...INSTANCE, release: VERSION },
      apiKey: TEST_KEY,
    })
    const m = mockFetch({ 'GET /api/me': () => jsonResponse(me) })
    const { ctx, out, log } = await testContext({ store, fetch: m.fetch, json: true })
    const opened: string[] = []
    const downloaded: string[] = []
    ctx.open = async f => opened.push(f)
    await runSetup(
      ctx,
      { yes: true },
      {
        runClaude: claude.run,
        findClaudeDesktop: async () => '/Applications/Claude.app',
        downloadExtension: async url => {
          downloaded.push(url)
          return '/tmp/x/fling.mcpb'
        },
      }
    )
    expect(downloaded).toEqual([`${SERVER}/downloads/fling.mcpb`])
    expect(opened).toEqual(['/tmp/x/fling.mcpb'])
    expect(log.lines.join('\n')).toContain(`Opened fling.mcpb ${VERSION} in Claude Desktop`)
    expect(JSON.parse(out.content()).claudeDesktop).toBe('done')
  })

  it("otherwise the GitHub Release of the CLI's version, then the server's copy", async () => {
    expect(extensionSources(SERVER, '0.7.0', '0.8.0')).toEqual([
      { url: `${REPO_URL}/releases/download/v0.8.0/fling.mcpb`, version: '0.8.0' },
      { url: `${SERVER}/downloads/fling.mcpb`, version: '0.7.0' },
    ])
    expect(extensionSources(SERVER, undefined, '0.8.0').map(s => s.url)).toEqual([
      `${REPO_URL}/releases/download/v0.8.0/fling.mcpb`,
      `${SERVER}/downloads/fling.mcpb`,
    ])

    const claude = fakeClaude({ '--version': { code: -1 } })
    const { ctx, out } = await setupCtx()
    const downloaded: string[] = []
    const opened: string[] = []
    ctx.open = async f => opened.push(f)
    await runSetup(
      ctx,
      { yes: true },
      {
        runClaude: claude.run,
        findClaudeDesktop: async () => '/Applications/Claude.app',
        downloadExtension: async url => {
          downloaded.push(url)
          if (url.startsWith(REPO_URL)) throw new Error('HTTP 404')
          return '/tmp/x/fling.mcpb'
        },
      }
    )
    expect(downloaded).toEqual([releaseExtensionUrl(VERSION), `${SERVER}/downloads/fling.mcpb`])
    expect(opened).toEqual(['/tmp/x/fling.mcpb'])
    expect(JSON.parse(out.content()).claudeDesktop).toBe('done')
  })

  it('refreshes the stored metadata of a server it is already signed in to', async () => {
    const store = await loggedInStore()
    const m = mockFetch({
      'GET /api/me': () => jsonResponse(me),
      'GET /.well-known/fling': () => jsonResponse({ ...INSTANCE, release: '9.9.9' }),
    })
    const { ctx } = await testContext({ store, fetch: m.fetch, json: true })
    await runSetup(
      ctx,
      { yes: true },
      {
        runClaude: fakeClaude({ '--version': { code: -1 } }).run,
        findClaudeDesktop: async () => null,
      }
    )
    expect((await store.resolve()).instance?.release).toBe('9.9.9')
  })

  it('rejects an unknown --scope', async () => {
    const { ctx } = await setupCtx()
    await expect(runSetup(ctx, { scope: 'global' })).rejects.toThrow(/--scope must be one of/)
  })
})
