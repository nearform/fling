/**
 * `fling doctor` and the `fling_doctor` MCP tool: diagnose this machine's Fling setup, one check
 * per line, each warning or problem with the fix. The checks:
 *
 *   - CLI: its version, Node.js against `engines`, the latest version on npm (skipped when the
 *     registry can't be reached), and whether `fling` on PATH is this CLI;
 *   - config: where it lives, the config file's permissions (it holds API keys), and FLING_URL /
 *     FLING_API_KEY in effect (named, never shown);
 *   - each Fling the CLI knows: its `/.well-known/fling`, its `release` against the CLI
 *     (update-check.ts), whether the stored API key is accepted, and the capabilities it reports;
 *   - Claude Code: `claude` on PATH, the plugin (installed, enabled, its version) and the
 *     marketplace;
 *   - Claude Desktop: the extension, from the data Desktop keeps (claude.ts).
 *
 * It reads and asks, and never changes anything: no config writes, no installs. Every request has
 * a short timeout. Everything it touches comes through `DoctorDeps`, which tests replace.
 */
import { execFile } from 'node:child_process'
import { access, constants, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstanceMetadata } from '@fling/shared'
import { createApiClient, type FetchLike } from './api.ts'
import {
  claudeCodeStatus,
  claudeDesktopDataDir,
  DESKTOP_EXTENSION_ID,
  desktopExtensionStatus,
  MARKETPLACE_NAME,
  MARKETPLACE_SOURCE,
  marketplaceConfigured,
  PLUGIN_ID,
  type RunClaude,
} from './claude.ts'
import {
  type ConfigStore,
  ENV,
  type Env,
  envOverrides,
  pathDirs,
  systemLocateOptions,
} from './config.ts'
import { exitCodeFor } from './errors.ts'
import { fetchInstance } from './instance.ts'
import { BIN_NAME, NODE_ENGINE, PACKAGE_NAME, VERSION } from './package-info.ts'
import { compareSemver, newerRelease, parseSemver, UPDATE_COMMAND } from './update-check.ts'

export type CheckStatus = 'ok' | 'warning' | 'problem'
export type CheckArea = 'cli' | 'config' | 'server' | 'claudeCode' | 'claudeDesktop'

export interface Check {
  area: CheckArea
  /** Stable id, e.g. `cli.node`, `server.signedIn`. */
  id: string
  status: CheckStatus
  message: string
  /** What to run (or do) to fix it; on every warning and problem. */
  fix?: string
  /** The Fling a server check is about. */
  server?: string
}

export interface ProgramResult {
  code: number
  stdout: string
}

export interface DoctorDeps {
  store: ConfigStore
  fetch: FetchLike
  env: Env
  runClaude: RunClaude
  /** Run a program (for `fling --version` of the one on PATH). Never throws. */
  runProgram: (file: string, args: readonly string[]) => Promise<ProgramResult>
  /** This CLI's script (`process.argv[1]`), to tell whether `fling` on PATH is it. */
  selfPath?: string
  nodeVersion: string
  platform: NodeJS.Platform
  home: string
  /** Where Claude Desktop is installed, or null. */
  findClaudeDesktop: () => Promise<string | null>
  /** Per request; default 5 s. */
  timeoutMs?: number
  version?: string
}

/** Where the npm registry says which version is `latest`. */
export const NPM_DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME.replace('/', '%2f')}/dist-tags`

const DEFAULT_TIMEOUT_MS = 5_000

const PLUGIN_UPDATE = `claude plugin marketplace update ${MARKETPLACE_NAME} && claude plugin update ${PLUGIN_ID}`

/** Run every check, in order. Never throws. */
export async function runChecks(deps: DoctorDeps): Promise<Check[]> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchWithTimeout: FetchLike = (input, init) =>
    deps.fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const d = { ...deps, fetch: fetchWithTimeout, timeoutMs, version: deps.version ?? VERSION }
  const groups = await Promise.all([
    cliChecks(d),
    configChecks(d),
    serverChecks(d),
    claudeCodeChecks(d),
    claudeDesktopChecks(d),
  ])
  return groups.flat()
}

/** Exit code: 1 when any check is a problem. */
export const doctorExitCode = (checks: readonly Check[]) =>
  checks.some(c => c.status === 'problem') ? 1 : 0

type Deps = DoctorDeps & { timeoutMs: number; version: string }

/** The doctor for this machine. */
export function systemDoctorDeps(
  store: ConfigStore,
  fetch: FetchLike,
  runClaude: RunClaude,
  findClaudeDesktop: () => Promise<string | null>
): DoctorDeps {
  const { env, home, platform } = systemLocateOptions()
  return {
    store,
    fetch,
    env,
    home,
    platform,
    runClaude,
    findClaudeDesktop,
    runProgram: (file, args) =>
      new Promise(resolve => {
        execFile(
          file,
          [...args],
          { timeout: DEFAULT_TIMEOUT_MS, shell: platform === 'win32' },
          (error, stdout) => resolve({ code: error ? 1 : 0, stdout: String(stdout) })
        )
      }),
    selfPath: process.argv[1],
    nodeVersion: process.versions.node,
  }
}

const SYMBOL: Record<CheckStatus, string> = { ok: '✔', warning: '▲', problem: '✖' }

/** One line per check, as text (the MCP tool's summary; the CLI colours its own). */
export function describeChecks(checks: readonly Check[]): string {
  return checks
    .map(c => `${SYMBOL[c.status]} ${c.message}${c.fix ? ` — fix: ${c.fix}` : ''}`)
    .join('\n')
}

// --- CLI ----------------------------------------------------------------------------------------

async function cliChecks(d: Deps): Promise<Check[]> {
  const checks: Check[] = [
    { area: 'cli', id: 'cli.version', status: 'ok', message: `${BIN_NAME} CLI ${d.version}` },
  ]
  const min = minimumNode(NODE_ENGINE)
  const node = parseSemver(d.nodeVersion)
  if (min && node) {
    checks.push(
      compareSemver(node, min.semver) >= 0
        ? { area: 'cli', id: 'cli.node', status: 'ok', message: `Node.js ${d.nodeVersion}` }
        : {
            area: 'cli',
            id: 'cli.node',
            status: 'problem',
            message: `Node.js ${d.nodeVersion} is too old: the CLI needs ${NODE_ENGINE}`,
            fix: `Install Node.js ${min.text} or later (https://nodejs.org)`,
          }
    )
  }
  const latest = await latestOnNpm(d)
  if (latest) {
    const newer = newerRelease(latest, d.version)
    checks.push(
      newer
        ? {
            area: 'cli',
            id: 'cli.latest',
            status: 'warning',
            message: `${PACKAGE_NAME} ${newer} is on npm (this CLI is ${d.version})`,
            fix: UPDATE_COMMAND,
          }
        : {
            area: 'cli',
            id: 'cli.latest',
            status: 'ok',
            message: `Up to date with npm (latest: ${latest})`,
          }
    )
  }
  checks.push(await onPath(d))
  return checks
}

/** `>=22`, `>=22.3`, `>=22.3.1` → the minimum; anything else → null (not checked). */
export function minimumNode(range: string) {
  const m = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim())
  if (!m) return null
  const text = [m[1], m[2], m[3]].filter(p => p !== undefined).join('.')
  const semver = parseSemver(`${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}`)
  return semver ? { text, semver } : null
}

async function latestOnNpm(d: Deps): Promise<string | null> {
  try {
    const response = await d.fetch(NPM_DIST_TAGS_URL, { headers: { Accept: 'application/json' } })
    if (!response.ok) return null
    const tags = (await response.json()) as { latest?: unknown }
    return typeof tags.latest === 'string' && parseSemver(tags.latest) ? tags.latest : null
  } catch {
    return null
  }
}

async function onPath(d: Deps): Promise<Check> {
  const names =
    d.platform === 'win32' ? [`${BIN_NAME}.cmd`, `${BIN_NAME}.exe`, BIN_NAME] : [BIN_NAME]
  let found: string | undefined
  for (const dir of pathDirs(d.env)) {
    for (const name of names) {
      const path = join(dir, name)
      if (await isExecutable(path, d.platform)) {
        found = path
        break
      }
    }
    if (found) break
  }
  const install = `npm i -g ${PACKAGE_NAME}@latest`
  if (!found)
    return {
      area: 'cli',
      id: 'cli.path',
      status: 'warning',
      message: `\`${BIN_NAME}\` is not on your PATH (this CLI runs through npx or another path)`,
      fix: install,
    }
  const real = await realpath(found).catch(() => found)
  const self = d.selfPath ? await realpath(d.selfPath).catch(() => d.selfPath) : undefined
  if (self && real === self)
    return {
      area: 'cli',
      id: 'cli.path',
      status: 'ok',
      message: `\`${BIN_NAME}\` on PATH is this CLI (${found})`,
    }
  // Another copy: it is fine when it is the same version.
  const other = await d.runProgram(found, ['--version'])
  const version = other.code === 0 ? other.stdout.trim().split(/\s+/).at(-1) : undefined
  if (version === d.version)
    return {
      area: 'cli',
      id: 'cli.path',
      status: 'ok',
      message: `\`${BIN_NAME}\` on PATH (${found}) is ${version}, as this CLI`,
    }
  return {
    area: 'cli',
    id: 'cli.path',
    status: 'warning',
    message: `\`${BIN_NAME}\` on PATH (${found}) is ${version ? `version ${version}` : 'another copy'}, not this CLI (${d.version})`,
    fix: `${install} && ${BIN_NAME} setup`,
  }
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const s = await stat(path)
    if (!s.isFile()) return false
    if (platform !== 'win32') await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// --- config -------------------------------------------------------------------------------------

async function configChecks(d: Deps): Promise<Check[]> {
  const overrides = envOverrides(d.env)
  const checks: Check[] = []
  const where = `${d.store.dir}${overrides.configDir ? ` (from ${ENV.configDir})` : ''}`
  const config = await d.store.load().catch(() => null)
  const fileMode = await stat(d.store.file).then(
    s => s.mode & 0o777,
    () => null
  )
  if (fileMode === null || !config || Object.keys(config.servers).length === 0) {
    checks.push({
      area: 'config',
      id: 'config.dir',
      status: 'warning',
      message: `No Fling is set up yet (config: ${where})`,
      fix: `${BIN_NAME} setup <your Fling's address>`,
    })
  } else {
    checks.push({ area: 'config', id: 'config.dir', status: 'ok', message: `Config: ${where}` })
  }
  if (fileMode !== null && d.platform !== 'win32') {
    const mode = fileMode.toString(8).padStart(3, '0')
    checks.push(
      fileMode & 0o077
        ? {
            area: 'config',
            id: 'config.permissions',
            status: 'problem',
            message: `${d.store.file} holds API keys and is readable by others (mode ${mode})`,
            fix: `chmod 600 "${d.store.file}"`,
          }
        : {
            area: 'config',
            id: 'config.permissions',
            status: 'ok',
            message: `The config file is private (mode ${mode})`,
          }
    )
  }
  if (overrides.url)
    checks.push({
      area: 'config',
      id: 'config.env.url',
      status: 'warning',
      message: `${ENV.url} is set: commands use the server it names, not the current one`,
      fix: `unset ${ENV.url} (if you did not mean to)`,
    })
  if (overrides.apiKey)
    checks.push({
      area: 'config',
      id: 'config.env.apiKey',
      status: 'warning',
      message: `${ENV.apiKey} is set: commands use that key, not the stored one`,
      fix: `unset ${ENV.apiKey} (if you did not mean to)`,
    })
  return checks
}

// --- servers ------------------------------------------------------------------------------------

async function serverChecks(d: Deps): Promise<Check[]> {
  const config = await d.store.load().catch(() => null)
  if (!config) return []
  const resolved = await d.store.resolve().catch(() => null)
  const urls = Object.keys(config.servers)
  // A server FLING_URL names without signing in to it is checked too.
  if (resolved?.serverUrl && !urls.includes(resolved.serverUrl)) urls.push(resolved.serverUrl)
  const perServer = await Promise.all(
    urls.map(async url => {
      const entry = config.servers[url] ?? {}
      const label = `${url}${url === config.current ? ' (current)' : ''}`
      const apiKey =
        resolved?.serverUrl === url && resolved.apiKeySource === 'env'
          ? resolved.apiKey
          : entry.apiKey
      return oneServer(d, url, label, apiKey)
    })
  )
  return perServer.flat()
}

async function oneServer(
  d: Deps,
  url: string,
  label: string,
  apiKey: string | undefined
): Promise<Check[]> {
  const at = (id: string, check: Omit<Check, 'area' | 'id' | 'server'>): Check => ({
    area: 'server',
    id,
    server: url,
    ...check,
  })
  let instance: InstanceMetadata
  try {
    instance = await fetchInstance(url, d.fetch)
  } catch (error) {
    return [
      at('server.metadata', {
        status: 'problem',
        message: `${label}: ${(error as Error).message}`,
        fix: `Check the address and your connection; if the Fling moved: ${BIN_NAME} login <its new address>`,
      }),
    ]
  }
  const checks: Check[] = [
    at('server.metadata', { status: 'ok', message: `${label}: ${instance.name} answers` }),
  ]
  const newer = newerRelease(instance.release, d.version)
  checks.push(
    newer
      ? at('server.release', {
          status: 'warning',
          message: `${label} runs Fling ${newer}, newer than this CLI (${d.version})`,
          fix: UPDATE_COMMAND,
        })
      : at('server.release', {
          status: 'ok',
          message: instance.release
            ? `${label} runs Fling ${instance.release}`
            : `${label} does not say which release it runs`,
        })
  )
  const login = `${BIN_NAME} login ${url}`
  if (!apiKey) {
    checks.push(
      at('server.signedIn', { status: 'problem', message: `${label}: not signed in`, fix: login })
    )
  } else {
    try {
      const client = createApiClient({
        serverUrl: url,
        apiKey,
        fetch: d.fetch,
        timeoutMs: d.timeoutMs,
      })
      const me = await client.request<{ email?: string }>('GET', '/api/me')
      checks.push(
        at('server.signedIn', {
          status: 'ok',
          message: `${label}: signed in${me?.email ? ` as ${me.email}` : ''}`,
        })
      )
    } catch (error) {
      checks.push(
        exitCodeFor(error) === 2
          ? at('server.signedIn', {
              status: 'problem',
              message: `${label}: the API key is not accepted`,
              fix: login,
            })
          : at('server.signedIn', {
              status: 'warning',
              message: `${label}: could not check the sign-in (${(error as Error).message})`,
              fix: `${BIN_NAME} whoami --server ${url}`,
            })
      )
    }
  }
  const on = Object.entries(instance.capabilities)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .sort()
  checks.push(
    at('server.capabilities', {
      status: 'ok',
      message: `${label}: ${on.length ? on.join(', ') : 'no optional features'}`,
    })
  )
  return checks
}

// --- Claude Code --------------------------------------------------------------------------------

async function claudeCodeChecks(d: Deps): Promise<Check[]> {
  const status = await claudeCodeStatus(d.runClaude).catch(() => ({ claude: 'missing' as const }))
  if (status.claude === 'missing')
    return [
      {
        area: 'claudeCode',
        id: 'claudeCode.cli',
        status: 'warning',
        message: 'Claude Code not found (no `claude` on your PATH)',
        fix: `Install Claude Code (https://claude.com/claude-code), then run \`${BIN_NAME} setup\``,
      },
    ]
  const checks: Check[] = [
    {
      area: 'claudeCode',
      id: 'claudeCode.cli',
      status: 'ok',
      message: `Claude Code ${status.claude}`,
    },
  ]
  const marketplace = await marketplaceConfigured(d.runClaude).catch(() => null)
  if (marketplace === false)
    checks.push({
      area: 'claudeCode',
      id: 'claudeCode.marketplace',
      status: 'warning',
      message: `The ${MARKETPLACE_NAME} marketplace is not configured in Claude Code`,
      fix: `${BIN_NAME} setup, or: claude plugin marketplace add ${MARKETPLACE_SOURCE}`,
    })
  else if (marketplace === true)
    checks.push({
      area: 'claudeCode',
      id: 'claudeCode.marketplace',
      status: 'ok',
      message: `The ${MARKETPLACE_NAME} marketplace is configured`,
    })
  if (!('installed' in status) || !status.installed) {
    checks.push({
      area: 'claudeCode',
      id: 'claudeCode.plugin',
      status: 'warning',
      message: 'The Fling plugin is not installed in Claude Code',
      fix: `${BIN_NAME} setup`,
    })
    return checks
  }
  if (status.enabled === false)
    checks.push({
      area: 'claudeCode',
      id: 'claudeCode.enabled',
      status: 'problem',
      message: 'The Fling plugin is installed but disabled',
      fix: `claude plugin enable ${PLUGIN_ID}`,
    })
  const behind = status.version ? newerRelease(d.version, status.version) : null
  checks.push(
    behind
      ? {
          area: 'claudeCode',
          id: 'claudeCode.plugin',
          status: 'warning',
          message: `The Fling plugin is ${status.version}, older than this CLI (${d.version})`,
          fix: `${BIN_NAME} setup, or: ${PLUGIN_UPDATE}`,
        }
      : {
          area: 'claudeCode',
          id: 'claudeCode.plugin',
          status: 'ok',
          message: `The Fling plugin is installed${status.version ? ` (${status.version})` : ''}${status.enabled === false ? '' : ' and enabled'}`,
        }
  )
  return checks
}

// --- Claude Desktop -----------------------------------------------------------------------------

async function claudeDesktopChecks(d: Deps): Promise<Check[]> {
  const app = await d.findClaudeDesktop().catch(() => null)
  if (!app) return []
  const dataDir = claudeDesktopDataDir(d.platform, d.env, d.home)
  const ext = dataDir ? await desktopExtensionStatus(dataDir) : null
  const at = (check: Omit<Check, 'area' | 'id'>): Check => ({
    area: 'claudeDesktop',
    id: 'claudeDesktop.extension',
    ...check,
  })
  if (!ext)
    return [
      at({
        status: 'ok',
        message: `Claude Desktop is installed (${app}); the extension could not be looked up`,
      }),
    ]
  if (!ext.installed)
    return [
      at({
        status: 'warning',
        message: 'The Fling extension is not installed in Claude Desktop',
        fix: `${BIN_NAME} setup (it opens fling.mcpb in Claude Desktop)`,
      }),
    ]
  const checks: Check[] = []
  if (ext.enabled === false)
    checks.push({
      area: 'claudeDesktop',
      id: 'claudeDesktop.enabled',
      status: 'problem',
      message: 'The Fling extension is installed in Claude Desktop but disabled',
      fix: 'Turn it on in Claude Desktop: Settings → Extensions → Fling',
    })
  const behind = ext.version ? newerRelease(d.version, ext.version) : null
  checks.push(
    behind
      ? at({
          status: 'warning',
          message: `The Claude Desktop extension is ${ext.version}, older than this CLI (${d.version})`,
          fix: `${BIN_NAME} setup`,
        })
      : at({
          status: 'ok',
          message: `The Claude Desktop extension is installed${ext.version ? ` (${ext.version})` : ''} (${DESKTOP_EXTENSION_ID})`,
        })
  )
  return checks
}
