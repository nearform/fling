/**
 * Find what the user means by a path. An existing path (absolute, `~/…` or relative to the working
 * directory) is used as is. Anything else — a bare file name ("Pitch Deck.html"), a path that only
 * exists inside Claude's sandbox (`/mnt/user-data/outputs/x.html`, `/sessions/…/outputs/x.html`) —
 * is looked up by name, newest first, in the places people and Claude Desktop put files:
 *
 *   the working directory (unless it is `/` or home), Downloads (FLING_DOWNLOADS_DIR or the
 *   platform default; XDG user-dirs on Linux), Desktop, ~/Documents/Claude, ~/Claude, and the
 *   `outputs` folders of Claude Desktop / Cowork sessions
 *   (macOS `~/Library/Application Support/Claude/local-agent-mode-sessions`,
 *   Windows `%APPDATA%\Claude\local-agent-mode-sessions`).
 *
 * The walk is bounded (depth per root, an entry budget and a time budget) and skips dot-folders,
 * node_modules and __MACOSX. Pure apart from the injectable filesystem: tests pass a fake one and
 * a `platform` to exercise Windows paths on any OS.
 */
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError } from './errors.ts'

export const DOWNLOADS_DIR_ENV = 'FLING_DOWNLOADS_DIR'

export interface FsStat {
  isFile: boolean
  isDirectory: boolean
  mtimeMs: number
  size: number
}

export interface FsEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
}

/** The filesystem calls the search needs; every method swallows errors (null / []). */
export interface LocateFs {
  stat(path: string): Promise<FsStat | null>
  /** Directory entries; symlinked directories are reported as neither file nor directory. */
  readdir(path: string): Promise<FsEntry[]>
  readText(path: string): Promise<string | null>
  /** Resolve symlinks (so overlapping roots dedupe); null when missing. Optional. */
  realpath?(path: string): Promise<string | null>
}

export interface LocateOptions {
  cwd: string
  home: string
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** Overrides the Downloads folder (else FLING_DOWNLOADS_DIR, else the platform default). */
  downloadsDir?: string
  fs?: LocateFs
  /** Give up walking after this long (default 4 s). */
  timeBudgetMs?: number
  /** Give up walking after this many directory entries (default 60 000). */
  entryBudget?: number
  now?: () => number
}

export interface SearchRoot {
  /** Human label, e.g. "Downloads". */
  label: string
  path: string
  /** How many folder levels below `path` to look. */
  depth: number
  /** Claude session store: search only the `outputs` folders found below it. */
  sessions?: boolean
}

export interface Candidate {
  path: string
  /** Label of the root it was found in. */
  foundIn: string
  kind: 'file' | 'folder'
  modified: string
  size: number
}

export interface Resolved {
  path: string
  /** `"path"` when the input existed as given, else the label of the root it was found in. */
  foundIn: string
  isDirectory: boolean
  /** Other matches, newest first (only when found by searching). */
  alternatives: Candidate[]
}

export const FOUND_AS_GIVEN = 'path'

const SKIP_DIRS = new Set(['node_modules', '__MACOSX', 'Library', 'AppData', '$RECYCLE.BIN'])
const SESSION_SKIP_DIRS = new Set(['skills-plugin', 'rpm', 'uploads', 'memory'])
const SESSIONS_DEPTH = 4
const OUTPUTS_DEPTH = 4
/** Sandbox / VM path prefixes Claude uses for its own files: never real paths on this computer. */
const SANDBOX_PATH_RE = /^\/(mnt\/user-data|mnt\/data|sessions|home\/claude|tmp\/outputs)(\/|$)/

export const nodeFs: LocateFs = {
  async stat(path) {
    try {
      const s = await stat(path)
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs, size: s.size }
    } catch {
      return null
    }
  },
  async readdir(path) {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      const out: FsEntry[] = []
      for (const e of entries) {
        if (e.isSymbolicLink()) {
          // Follow links to files (a linked download), never to folders (cycles).
          const s = await stat(`${path}/${e.name}`).catch(() => null)
          out.push({ name: e.name, isFile: Boolean(s?.isFile()), isDirectory: false })
        } else out.push({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() })
      }
      return out
    } catch {
      return []
    }
  },
  async realpath(path) {
    return realpath(path).catch(() => null)
  },
  async readText(path) {
    try {
      if (!(await lstat(path)).isFile()) return null
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  },
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix)

const usable = (value: string | undefined): value is string =>
  Boolean(value?.trim()) && !value?.trim().startsWith('${')

/** `XDG_<KEY>_DIR` from the env or `~/.config/user-dirs.dirs` (Linux). */
async function xdgUserDir(
  key: 'DOWNLOAD' | 'DESKTOP' | 'DOCUMENTS',
  opts: LocateOptions,
  fs: LocateFs
): Promise<string | undefined> {
  const fromEnv = opts.env[`XDG_${key}_DIR`]
  if (usable(fromEnv)) return fromEnv
  const configHome = opts.env.XDG_CONFIG_HOME || posix.join(opts.home, '.config')
  const text = await fs.readText(posix.join(configHome, 'user-dirs.dirs'))
  const match = text?.match(new RegExp(`^XDG_${key}_DIR="([^"]*)"`, 'm'))
  if (!match?.[1]) return undefined
  return match[1].replace(/^\$HOME(?=\/|$)/, opts.home)
}

/** The folders searched, in order. Folders that do not exist are dropped by the walk. */
export async function searchRoots(opts: LocateOptions): Promise<SearchRoot[]> {
  const fs = opts.fs ?? nodeFs
  const p = pathFor(opts.platform)
  const { home, env, platform } = opts
  const userHome = platform === 'win32' && usable(env.USERPROFILE) ? env.USERPROFILE : home
  const roots: SearchRoot[] = []
  const add = (label: string, path: string | undefined, depth: number, sessions = false) => {
    if (!path) return
    const norm = p.resolve(path)
    if (roots.some(r => r.path === norm)) return
    roots.push({ label, path: norm, depth, ...(sessions ? { sessions } : {}) })
  }

  const cwd = p.resolve(opts.cwd)
  if (cwd !== p.parse(cwd).root && cwd !== p.resolve(userHome)) add('current folder', cwd, 4)

  const configured = usable(opts.downloadsDir)
    ? opts.downloadsDir
    : usable(env[DOWNLOADS_DIR_ENV])
      ? env[DOWNLOADS_DIR_ENV]
      : undefined
  const defaultDownloads =
    platform === 'linux'
      ? ((await xdgUserDir('DOWNLOAD', opts, fs)) ?? p.join(home, 'Downloads'))
      : p.join(userHome, 'Downloads')
  add('Downloads', configured ? expandHome(configured, home, platform) : defaultDownloads, 3)
  add('Downloads', defaultDownloads, 3)

  const desktop =
    platform === 'linux'
      ? ((await xdgUserDir('DESKTOP', opts, fs)) ?? p.join(home, 'Desktop'))
      : p.join(userHome, 'Desktop')
  add('Desktop', desktop, 3)
  if (platform === 'win32' && usable(env.OneDrive))
    add('Desktop', p.join(env.OneDrive, 'Desktop'), 3)

  const documents =
    platform === 'linux'
      ? ((await xdgUserDir('DOCUMENTS', opts, fs)) ?? p.join(home, 'Documents'))
      : p.join(userHome, 'Documents')
  add('Documents/Claude', p.join(documents, 'Claude'), 4)
  add('~/Claude', p.join(userHome, 'Claude'), 4)

  const claudeConfig =
    platform === 'darwin'
      ? p.join(home, 'Library', 'Application Support', 'Claude')
      : platform === 'win32'
        ? p.join(
            usable(env.APPDATA) ? env.APPDATA : p.join(userHome, 'AppData', 'Roaming'),
            'Claude'
          )
        : p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'Claude')
  add(
    'Claude Desktop outputs',
    p.join(claudeConfig, 'local-agent-mode-sessions'),
    SESSIONS_DEPTH,
    true
  )

  // Same folder through a symlink (macOS /var → /private/var…): keep the first.
  if (!fs.realpath) return roots
  const real: SearchRoot[] = []
  for (const root of roots) {
    const path = (await fs.realpath(root.path)) ?? root.path
    if (!real.some(r => r.path === path)) real.push({ ...root, path })
  }
  return real
}

export function expandHome(input: string, home: string, platform: NodeJS.Platform): string {
  if (input === '~') return home
  if (input.startsWith('~/') || (platform === 'win32' && input.startsWith('~\\')))
    return pathFor(platform).join(home, input.slice(2))
  return input
}

// ---- walking -------------------------------------------------------------------------------

interface Visit {
  root: SearchRoot
  path: string
  entry: FsEntry
  /** Entries of the folder `entry` is in (to spot index.html next to it). */
  siblings: FsEntry[]
}

/**
 * Walk the roots breadth-first within their depth and the budgets, calling `visit` for every entry.
 * `visit` returning `'skip'` for a folder stops the walk descending into it.
 */
async function walk(
  roots: SearchRoot[],
  opts: LocateOptions,
  visit: (v: Visit) => Promise<undefined | 'skip'>
): Promise<{ complete: boolean }> {
  const fs = opts.fs ?? nodeFs
  const p = pathFor(opts.platform)
  const now = opts.now ?? Date.now
  const deadline = now() + (opts.timeBudgetMs ?? 4000)
  let budget = opts.entryBudget ?? 60_000
  const skip = (name: string) => name.startsWith('.') || SKIP_DIRS.has(name)

  // Expand the session store into its `outputs` folders.
  const expanded: SearchRoot[] = []
  for (const root of roots) {
    if (!root.sessions) {
      expanded.push(root)
      continue
    }
    let level = [root.path]
    for (let depth = 0; depth < root.depth && level.length; depth++) {
      const next: string[] = []
      for (const dir of level) {
        for (const e of await fs.readdir(dir)) {
          if (!e.isDirectory || skip(e.name) || SESSION_SKIP_DIRS.has(e.name)) continue
          const child = p.join(dir, e.name)
          if (e.name === 'outputs')
            expanded.push({ label: root.label, path: child, depth: OUTPUTS_DEPTH })
          else next.push(child)
        }
      }
      level = next
    }
  }

  for (const root of expanded) {
    let level = [root.path]
    for (let depth = 0; depth <= root.depth && level.length; depth++) {
      const next: string[] = []
      for (const dir of level) {
        if (now() > deadline || budget <= 0) return { complete: false }
        const entries = await fs.readdir(dir)
        budget -= entries.length
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue
          const path = p.join(dir, entry.name)
          const result = await visit({ root, path, entry, siblings: entries })
          if (entry.isDirectory && !skip(entry.name) && result !== 'skip' && depth < root.depth)
            next.push(path)
        }
      }
      level = next
    }
  }
  return { complete: true }
}

/** Browsers save a second download of `deck.html` as `deck (1).html`. */
function withoutDuplicateSuffix(name: string): string {
  return name.replace(/ \(\d+\)(?=\.[^.]+$|$)/, '')
}

function namesMatch(candidate: string, wanted: string): boolean {
  const a = candidate.toLowerCase()
  const b = wanted.toLowerCase()
  return a === b || withoutDuplicateSuffix(a) === withoutDuplicateSuffix(b)
}

const splitSegments = (path: string) =>
  path.split(/[\\/]+/).filter(s => s !== '' && s !== '.' && s !== '~')

/** How many trailing path segments of `path` equal the wanted ones (the name counts as 1). */
function suffixScore(path: string, wanted: string[]): number {
  const have = splitSegments(path)
  let score = 1
  for (let i = 2; i <= Math.min(have.length, wanted.length); i++) {
    if (have[have.length - i]?.toLowerCase() !== wanted[wanted.length - i]?.toLowerCase()) break
    score++
  }
  return score
}

const looksLikeSandboxPath = (input: string) => SANDBOX_PATH_RE.test(input.replace(/\\/g, '/'))

function normaliseInput(raw: string, opts: LocateOptions): string {
  let input = raw.trim().replace(/^(["'])(.*)\1$/, '$2')
  if (input.startsWith('file://')) {
    try {
      input = fileURLToPath(input, { windows: opts.platform === 'win32' })
    } catch {
      input = decodeURIComponent(input.slice('file://'.length))
    }
  }
  return expandHome(input, opts.home, opts.platform)
}

/**
 * Resolve user input to a file or folder on this computer (see the module comment). Throws a
 * CliError listing where it looked when nothing matches.
 */
export async function resolveInput(input: string, opts: LocateOptions): Promise<Resolved> {
  const fs = opts.fs ?? nodeFs
  const p = pathFor(opts.platform)
  const given = normaliseInput(input, opts)
  if (!given) throw new CliError('No path given')

  const direct = p.isAbsolute(given) ? p.normalize(given) : p.resolve(opts.cwd, given)
  const directStat = await fs.stat(direct)
  if (directStat && (directStat.isFile || directStat.isDirectory)) {
    return {
      path: direct,
      foundIn: FOUND_AS_GIVEN,
      isDirectory: directStat.isDirectory,
      alternatives: [],
    }
  }

  const wanted = splitSegments(given)
  const name = wanted.at(-1)
  const roots = await searchRoots(opts)
  if (!name) throw notFound(input, roots)

  const found: (Candidate & { score: number; mtimeMs: number; isDirectory: boolean })[] = []
  const seen = new Set<string>()
  await walk(roots, opts, async ({ root, path, entry }) => {
    if (!(entry.isFile || entry.isDirectory) || !namesMatch(entry.name, name)) return
    if (seen.has(path)) return
    seen.add(path)
    const s = await fs.stat(path)
    if (!s) return
    found.push({
      path,
      foundIn: root.label,
      kind: s.isDirectory ? 'folder' : 'file',
      modified: new Date(s.mtimeMs).toISOString(),
      size: s.size,
      score: suffixScore(path, wanted),
      mtimeMs: s.mtimeMs,
      isDirectory: s.isDirectory,
    })
    return undefined
  })
  if (found.length === 0) throw notFound(input, roots)

  found.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs)
  const strip = ({ score: _s, mtimeMs: _m, isDirectory: _d, ...c }: (typeof found)[number]) => c
  const [best, ...rest] = found as [(typeof found)[number], ...typeof found]
  return {
    path: best.path,
    foundIn: best.foundIn,
    isDirectory: best.isDirectory,
    alternatives: rest.slice(0, 5).map(strip),
  }
}

function notFound(input: string, roots: SearchRoot[]): CliError {
  const where = roots.map(r => `${r.label} (${r.path})`).join(', ')
  const sandbox = looksLikeSandboxPath(input)
    ? ' That looks like a path inside Claude’s sandbox, which this computer cannot see: publish the content inline with fling_publish, or save/download the file to this computer first.'
    : ''
  return new CliError(`Could not find "${input}". Looked for it by name in: ${where}.${sandbox}`, {
    hint: 'Pass the full path, or save the file to your Downloads folder and use just its name.',
  })
}

// ---- listing -------------------------------------------------------------------------------

export interface FindFilesOptions {
  /** Case-insensitive substring of the file or folder name. */
  query?: string
  /** Max results (default 20). */
  limit?: number
  /** Only things modified in the last N days (default 14). */
  days?: number
}

const LISTED_EXT = /\.(html?|zip)$/i

/**
 * Recent things worth flinging, newest first: .html/.htm/.zip files and folders that contain an
 * index.html (listed once, not descended into).
 */
export async function findFiles(
  opts: LocateOptions,
  find: FindFilesOptions = {}
): Promise<{ files: Candidate[]; searched: SearchRoot[]; complete: boolean }> {
  const fs = opts.fs ?? nodeFs
  const p = pathFor(opts.platform)
  const now = (opts.now ?? Date.now)()
  const since = now - (find.days ?? 14) * 24 * 60 * 60 * 1000
  const query = find.query?.trim().toLowerCase()
  const roots = await searchRoots(opts)
  const found = new Map<string, Candidate & { mtimeMs: number }>()
  const rootPaths = new Set(roots.map(r => r.path))

  const { complete } = await walk(roots, opts, async ({ root, path, entry }) => {
    if (entry.isDirectory) {
      if (rootPaths.has(path)) return
      const index = (await fs.readdir(path)).find(e => e.isFile && /^index\.html?$/i.test(e.name))
      if (!index) return
      const s = await fs.stat(p.join(path, index.name))
      if (s && s.mtimeMs >= since && (!query || entry.name.toLowerCase().includes(query)))
        found.set(path, {
          path,
          foundIn: root.label,
          kind: 'folder',
          modified: new Date(s.mtimeMs).toISOString(),
          size: s.size,
          mtimeMs: s.mtimeMs,
        })
      return 'skip'
    }
    if (!entry.isFile || !LISTED_EXT.test(entry.name)) return
    if (query && !entry.name.toLowerCase().includes(query)) return
    const s = await fs.stat(path)
    if (!s || s.mtimeMs < since || found.has(path)) return
    found.set(path, {
      path,
      foundIn: root.label,
      kind: 'file',
      modified: new Date(s.mtimeMs).toISOString(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    })
    return undefined
  })

  const files = [...found.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, find.limit ?? 20)
    .map(({ mtimeMs: _m, ...c }) => c)
  return { files, searched: roots, complete }
}
