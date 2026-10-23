import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeResult } from '../src/claude.ts'
import { runSetup } from '../src/commands/setup.ts'
import { jsonResponse, loggedInStore, mockFetch, runCleanups, testContext } from './helpers.ts'

afterEach(async () => {
  await runCleanups()
  process.exitCode = undefined
})

const me = { email: 'ada@nearform.com', name: 'Ada', picture: null, userSlug: 'ada' }

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
  it('installs the Claude Code plugin from the nearform/fling marketplace', async () => {
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
      'nearform/fling',
      '-s',
      'user',
    ])
    expect(JSON.parse(out.content())).toEqual({
      login: 'already',
      claudeCode: 'done',
      claudeDesktop: 'missing',
    })
  })

  it('updates the plugin when it is already installed', async () => {
    const claude = fakeClaude({
      '--version': { stdout: '2.1.0 (Claude Code)' },
      'plugin list': {
        stdout: JSON.stringify([{ id: 'fling@fling', version: '0.1.2', scope: 'user' }]),
      },
    })
    const { ctx, out } = await setupCtx()
    await runSetup(
      ctx,
      { yes: true },
      { runClaude: claude.run, findClaudeDesktop: async () => null }
    )
    expect(claude.calls).toContainEqual(['plugin', 'marketplace', 'update', 'fling'])
    expect(claude.calls).toContainEqual(['plugin', 'update', 'fling@fling', '-s', 'user'])
    expect(JSON.parse(out.content()).claudeCode).toBe('updated')
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
    expect(a.log.lines.join('\n')).toMatch(/\/plugin marketplace add nearform\/fling/)
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

  it('opens the downloaded extension when Claude Desktop is installed', async () => {
    const claude = fakeClaude({ '--version': { code: -1 } })
    const { ctx, out } = await setupCtx()
    const opened: string[] = []
    ctx.open = async f => opened.push(f)
    await runSetup(
      ctx,
      { yes: true },
      {
        runClaude: claude.run,
        findClaudeDesktop: async () => '/Applications/Claude.app',
        downloadExtension: async () => '/tmp/x/fling.mcpb',
      }
    )
    expect(opened).toEqual(['/tmp/x/fling.mcpb'])
    expect(JSON.parse(out.content()).claudeDesktop).toBe('done')
  })

  it('rejects an unknown --scope', async () => {
    const { ctx } = await setupCtx()
    await expect(runSetup(ctx, { scope: 'global' })).rejects.toThrow(/--scope must be one of/)
  })
})
