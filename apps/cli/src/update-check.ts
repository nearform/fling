/**
 * The update check: whether the Fling a command talked to runs a newer release than this CLI, from
 * the `release` in its `/.well-known/fling` (the metadata the CLI already holds; this module never
 * makes a request). The CLI says so on stderr at most once a day per server, remembering when in
 * `update-check.json` in its config dir; the local MCP server tells Claude instead (mcp.ts).
 *
 * It never fails or slows a command: a missing or malformed `release`, or an unreadable state
 * file, means nothing is said.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type ConfigStore, updateCheckSilenced } from './config.ts'
import type { CommandContext } from './context.ts'
import { BIN_NAME, PACKAGE_NAME, VERSION } from './package-info.ts'

/** The command that updates the CLI and, through setup, the plugin and the Desktop extension. */
export const UPDATE_COMMAND = `npm i -g ${PACKAGE_NAME}@latest && ${BIN_NAME} setup`

export const UPDATE_STATE_FILE = 'update-check.json'

/** How long after telling the user about one server the CLI stays quiet about it. */
export const NOTIFY_EVERY_MS = 24 * 60 * 60 * 1000

interface Semver {
  core: [number, number, number]
  pre: string[]
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/** `x.y.z[-pre][+build]` (a leading `v` allowed), else null. */
export function parseSemver(input: unknown): Semver | null {
  if (typeof input !== 'string') return null
  const m = SEMVER.exec(input.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** Semver precedence: negative when `a` < `b`, 0 when equal, positive when `a` > `b`. */
export function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    const d = (a.core[i] ?? 0) - (b.core[i] ?? 0)
    if (d !== 0) return d
  }
  // A pre-release comes before its release.
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) - Number(y)
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * The server's `release` when it is a newer semver than `version` (default: this CLI's), else null:
 * older, equal, missing or malformed releases say nothing.
 */
export function newerRelease(release: unknown, version: string = VERSION): string | null {
  const theirs = parseSemver(release)
  const ours = parseSemver(version)
  if (!theirs || !ours || compareSemver(theirs, ours) <= 0) return null
  return String(release).trim()
}

/** The line the CLI prints on stderr. */
export const updateLine = (release: string, version: string = VERSION) =>
  `Fling ${release} is out (this CLI is ${version}). Update: ${UPDATE_COMMAND}`

/** What the local MCP server tells Claude, which then tells the user. */
export const mcpUpdateNote = (release: string, version: string = VERSION) =>
  `Fling ${release} is out and this Fling MCP server is ${version}. Tell the user once in this conversation, and suggest they update by running \`${UPDATE_COMMAND}\` in a terminal, then restarting Claude.`

export interface UpdateCheckInput {
  store: Pick<ConfigStore, 'dir'>
  /** The server the command talked to. */
  serverUrl?: string
  /** That server's `release`, from the metadata the command holds. */
  release?: unknown
  json: boolean
  /** Whether stderr is a terminal. */
  stderrTTY: boolean
  /** `CI` or `FLING_NO_UPDATE_CHECK` is set (`updateCheckSilenced` in config.ts). */
  silenced: boolean
  now?: Date
  version?: string
}

/**
 * The line to print after a command, or null. When it returns a line, it has recorded the time
 * for that server, so the next one comes a day later at the earliest. Never throws.
 */
export async function updateNotice(input: UpdateCheckInput): Promise<string | null> {
  try {
    if (input.json || !input.stderrTTY || input.silenced || !input.serverUrl) return null
    const version = input.version ?? VERSION
    const release = newerRelease(input.release, version)
    if (!release) return null
    const now = input.now ?? new Date()
    const file = join(input.store.dir, UPDATE_STATE_FILE)
    const state = await readState(file)
    const last = Date.parse(state.notified[input.serverUrl] ?? '')
    if (Number.isFinite(last) && now.getTime() - last < NOTIFY_EVERY_MS) return null
    state.notified[input.serverUrl] = now.toISOString()
    await mkdir(input.store.dir, { recursive: true, mode: 0o700 })
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    return updateLine(release, version)
  } catch {
    return null
  }
}

/**
 * After a command: warn on stderr when the server it used (`--server`, else the current one) runs
 * a newer release. The stored metadata is read again, as the command may have refreshed it.
 */
export async function noticeAfterCommand(
  ctx: Pick<CommandContext, 'store' | 'config' | 'json' | 'log'>,
  server: string | undefined,
  options: { stderrTTY?: boolean; silenced?: boolean; now?: Date; version?: string } = {}
): Promise<void> {
  try {
    const config = await ctx.store.resolve({ serverUrl: server }).catch(() => ctx.config)
    const line = await updateNotice({
      store: ctx.store,
      serverUrl: config.serverUrl,
      release: config.instance?.release,
      json: ctx.json,
      stderrTTY: options.stderrTTY ?? Boolean(process.stderr.isTTY),
      silenced: options.silenced ?? updateCheckSilenced(),
      now: options.now,
      version: options.version,
    })
    if (line) ctx.log.warn(line)
  } catch {
    // never fail a command over this
  }
}

interface UpdateState {
  /** Server address → when the user was last told about a newer release there (ISO time). */
  notified: Record<string, string>
}

async function readState(file: string): Promise<UpdateState> {
  try {
    const json = JSON.parse(await readFile(file, 'utf8')) as { notified?: unknown }
    const notified = json?.notified
    if (notified && typeof notified === 'object' && !Array.isArray(notified)) {
      const entries = Object.entries(notified).filter(
        (e): e is [string, string] => typeof e[1] === 'string'
      )
      return { notified: Object.fromEntries(entries) }
    }
  } catch {
    // missing or unreadable: start afresh
  }
  return { notified: {} }
}
