/**
 * Installing Fling into Claude: the Claude Code plugin (skill + MCP server), through the `claude`
 * CLI, and the Claude Desktop extension (fling.mcpb), which Desktop installs when the file is
 * opened. `runClaude` is the seam tests replace.
 */
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_SLUG, REPO_URL } from '@fling/shared'
import extensionManifest from '../mcpb/manifest.json'
import type { FetchLike } from './api.ts'
import { VERSION } from './package-info.ts'

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

/** Whether `claude` knows the marketplace (by name), or null when it can't be told. */
export async function marketplaceConfigured(run: RunClaude): Promise<boolean | null> {
  const list = await run(['plugin', 'marketplace', 'list', '--json'])
  if (list.code !== 0) return null
  try {
    const marketplaces = JSON.parse(list.stdout) as { name?: string }[]
    return Array.isArray(marketplaces) && marketplaces.some(m => m.name === MARKETPLACE_NAME)
  } catch {
    return null
  }
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

/**
 * The id Claude Desktop installs the extension under: `local.mcpb.<author>.<name>`, from the
 * manifest (neither ever changes, so every copy updates the same install).
 */
export const DESKTOP_EXTENSION_ID = `local.mcpb.${extensionManifest.author.name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')}.${extensionManifest.name}`

/** Where Claude Desktop keeps its data (extensions among it), or null where there is none. */
export function claudeDesktopDataDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): string | null {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude')
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'Claude')
  return null
}

export type DesktopExtensionStatus =
  | { installed: false }
  | { installed: true; version?: string; enabled?: boolean }

/** Is the Fling extension installed in Claude Desktop (data in `dataDir`), at which version? */
export async function desktopExtensionStatus(dataDir: string): Promise<DesktopExtensionStatus> {
  const readJson = async (path: string) => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    } catch {
      return null
    }
  }
  const manifest = await readJson(
    join(dataDir, 'Claude Extensions', DESKTOP_EXTENSION_ID, 'manifest.json')
  )
  if (!manifest) return { installed: false }
  const settings = await readJson(
    join(dataDir, 'Claude Extensions Settings', `${DESKTOP_EXTENSION_ID}.json`)
  )
  return {
    installed: true,
    ...(typeof manifest.version === 'string' ? { version: manifest.version } : {}),
    ...(typeof settings?.isEnabled === 'boolean' ? { enabled: settings.isEnabled } : {}),
  }
}

/** A place fling.mcpb is downloaded from, and the version it holds when known. */
export interface ExtensionSource {
  url: string
  version?: string
}

/** The extension attached to the GitHub Release of `version`. */
export const releaseExtensionUrl = (version: string) =>
  `${REPO_URL}/releases/download/v${version}/fling.mcpb`

/**
 * Where to get the extension that matches this CLI, in order. The server's copy, when it runs
 * the CLI's release: it also adds that Fling on start (FLING_ADD_SERVER). Otherwise the GitHub
 * Release of the CLI's version first, then the server's copy (the server's release) should that
 * download fail.
 */
export function extensionSources(
  serverUrl: string,
  serverRelease: string | undefined,
  version: string = VERSION
): ExtensionSource[] {
  const server: ExtensionSource = {
    url: new URL(MCPB_PATH, serverUrl).toString(),
    ...(serverRelease ? { version: serverRelease } : {}),
  }
  if (serverRelease === version) return [server]
  return [{ url: releaseExtensionUrl(version), version }, server]
}

/** Download fling.mcpb from `url` into a temp folder; returns its path. */
export async function downloadExtension(url: string, fetch: FetchLike): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status})`)
  const dir = await mkdtemp(join(tmpdir(), 'fling-mcpb-'))
  const file = join(dir, 'fling.mcpb')
  await writeFile(file, Buffer.from(await response.arrayBuffer()))
  return file
}
