/**
 * Installing Fling into Claude: the Claude Code plugin (skill + MCP server), through the `claude`
 * CLI, and the Claude Desktop extension (fling.mcpb), which Desktop installs when the file is
 * opened. `runClaude` is the seam tests replace.
 */
import { execFile } from 'node:child_process'
import { access, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_SLUG } from '@fling/shared'
import type { FetchLike } from './api.ts'

/** The marketplace (this repo) and the plugin in it. */
export const MARKETPLACE_SOURCE = REPO_SLUG
export const MARKETPLACE_NAME = 'fling'
export const PLUGIN_NAME = 'fling'
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`
export const MCPB_PATH = '/downloads/fling.mcpb'

export type PluginScope = 'user' | 'project' | 'local'

export interface ClaudeResult {
  code: number
  stdout: string
  stderr: string
}

/** Run `claude <args>`; `code` is -1 when `claude` is not installed. Never throws. */
export type RunClaude = (args: readonly string[]) => Promise<ClaudeResult>

export const runClaude: RunClaude = args =>
  new Promise(resolve => {
    execFile(
      'claude',
      [...args],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, shell: process.platform === 'win32' },
      (error, stdout, stderr) => {
        const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
        const code = !error ? 0 : missing ? -1 : typeof error.code === 'number' ? error.code : 1
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

export type PluginStatus =
  | { claude: 'missing' }
  | { claude: string; installed: false }
  | { claude: string; installed: true; version?: string; scope?: string; enabled?: boolean }

/** Is Claude Code installed, and is the Fling plugin? */
export async function claudeCodeStatus(run: RunClaude): Promise<PluginStatus> {
  const version = await run(['--version'])
  if (version.code !== 0) return { claude: 'missing' }
  const claude = version.stdout.trim().split(/\s+/)[0] ?? 'unknown'
  const list = await run(['plugin', 'list', '--json'])
  let plugins: { id?: string; version?: string; scope?: string; enabled?: boolean }[] = []
  try {
    plugins = JSON.parse(list.stdout)
  } catch {
    // an older `claude` without --json: treat as not installed; install will say if it is
  }
  const fling = Array.isArray(plugins) ? plugins.find(p => p.id === PLUGIN_ID) : undefined
  if (!fling) return { claude, installed: false }
  return {
    claude,
    installed: true,
    version: fling.version,
    scope: fling.scope,
    enabled: fling.enabled,
  }
}

/** Add the marketplace (if needed) and install the plugin. Throws with claude's own message. */
export async function installPlugin(run: RunClaude, scope: PluginScope): Promise<void> {
  check(
    await run(['plugin', 'install', PLUGIN_NAME, '--marketplace', MARKETPLACE_SOURCE, '-s', scope]),
    'install the Fling plugin'
  )
}

/** Refresh the marketplace and update the installed plugin to its latest version. */
export async function updatePlugin(run: RunClaude, scope?: string): Promise<void> {
  check(await run(['plugin', 'marketplace', 'update', MARKETPLACE_NAME]), 'update the marketplace')
  check(
    await run(['plugin', 'update', PLUGIN_ID, ...(scope ? ['-s', scope] : [])]),
    'update the Fling plugin'
  )
}

function check(result: ClaudeResult, what: string): void {
  if (result.code === 0) return
  const detail = (result.stderr || result.stdout).trim().split('\n').at(-1)
  throw new Error(`Could not ${what}${detail ? `: ${detail}` : ''}`)
}

/** Where Claude Desktop lives on this machine, or null (Linux has no Claude Desktop). */
export async function findClaudeDesktop(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => Promise<boolean> = path =>
    access(path).then(
      () => true,
      () => false
    )
): Promise<string | null> {
  const candidates =
    platform === 'darwin'
      ? ['/Applications/Claude.app', join(homedir(), 'Applications', 'Claude.app')]
      : platform === 'win32' && env.LOCALAPPDATA
        ? [join(env.LOCALAPPDATA, 'AnthropicClaude'), join(env.LOCALAPPDATA, 'Programs', 'Claude')]
        : []
  for (const path of candidates) if (await exists(path)) return path
  return null
}

/** Download fling.mcpb from the server into a temp folder; returns its path. */
export async function downloadExtension(serverUrl: string, fetch: FetchLike): Promise<string> {
  const url = new URL(MCPB_PATH, serverUrl).toString()
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status})`)
  const dir = await mkdtemp(join(tmpdir(), 'fling-mcpb-'))
  const file = join(dir, 'fling.mcpb')
  await writeFile(file, Buffer.from(await response.arrayBuffer()))
  return file
}
