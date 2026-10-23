/**
 * Which files in a folder are gitignored, so the walker (manifest.ts) never flings them.
 *
 * - The folder is inside a git work tree and is itself tracked (neither it nor an ancestor up to
 *   the repo root is ignored): git decides — every file `git ls-files --others --ignored
 *   --exclude-standard --directory` reports is skipped (all .gitignore levels, .git/info/exclude
 *   and the global excludes file).
 * - The folder is ignored itself (the usual case for build output such as dist/ or build/): asking
 *   git would mark everything as ignored, so instead only the `.gitignore` files *inside* the
 *   folder apply.
 * - No git (not installed, not a repo, or git fails): the `.gitignore` files inside the folder
 *   apply, as above.
 */
import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import ignore, { type Ignore } from 'ignore'

export type GitIgnoreMode = 'git' | 'nested'

export interface GitIgnore {
  mode: GitIgnoreMode
  /**
   * Is `rel` (site-relative POSIX path) ignored? Directories are passed with `isDir`. In `nested`
   * mode the walker must call `enterDir` for each directory before asking about its entries.
   */
  ignores(rel: string, isDir: boolean): boolean
  /** Load `<dir>/.gitignore` (nested mode; no-op otherwise). */
  enterDir(absDir: string, relDir: string): Promise<void>
}

const GIT_TIMEOUT_MS = 20_000

function git(cwd: string, args: string[], input?: string): Promise<string | null> {
  return new Promise(resolve => {
    try {
      const child = execFile(
        'git',
        ['-C', cwd, ...args],
        { timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          // check-ignore exits 1 when nothing is ignored: that's an answer, not a failure.
          const code = (error as { code?: unknown } | null)?.code
          if (error && !(args[0] === 'check-ignore' && code === 1)) resolve(null)
          else resolve(stdout)
        }
      )
      child.on('error', () => resolve(null))
      if (input !== undefined) child.stdin?.end(input)
    } catch {
      resolve(null)
    }
  })
}

/** Is `root` (a realpath) itself ignored by the repo it is in? */
async function rootIsIgnored(top: string, root: string): Promise<boolean> {
  const rel = relative(top, root)
  if (!rel || rel.startsWith('..')) return false
  const segments = rel.split(sep)
  // The folder and each ancestor up to (not including) the repo root.
  const candidates = segments.map((_, i) => `${segments.slice(0, i + 1).join('/')}/`)
  const out = await git(top, ['check-ignore', '--stdin', '-z'], `${candidates.join('\0')}\0`)
  return out !== null && out.split('\0').some(Boolean)
}

function gitMode(entries: string[]): GitIgnore {
  const files = new Set<string>()
  const dirs: string[] = []
  for (const e of entries) {
    if (!e) continue
    if (e.endsWith('/')) dirs.push(e)
    else files.add(e)
  }
  const dirSet = new Set(dirs)
  return {
    mode: 'git',
    ignores(rel, isDir) {
      if (isDir ? dirSet.has(`${rel}/`) : files.has(rel)) return true
      let i = rel.indexOf('/')
      while (i !== -1) {
        if (dirSet.has(rel.slice(0, i + 1))) return true
        i = rel.indexOf('/', i + 1)
      }
      return false
    },
    async enterDir() {},
  }
}

function nestedMode(): GitIgnore {
  const levels: { base: string; ig: Ignore }[] = []
  return {
    mode: 'nested',
    ignores(rel, isDir) {
      for (const { base, ig } of levels) {
        if (base && !rel.startsWith(`${base}/`)) continue
        const sub = base ? rel.slice(base.length + 1) : rel
        if (sub && ig.ignores(isDir ? `${sub}/` : sub)) return true
      }
      return false
    },
    async enterDir(absDir, relDir) {
      let text: string
      try {
        text = await readFile(join(absDir, '.gitignore'), 'utf8')
      } catch {
        return
      }
      levels.push({ base: relDir, ig: ignore().add(text) })
    },
  }
}

/** How to tell gitignored files in `root` (a realpath'd folder). */
export async function loadGitIgnore(root: string): Promise<GitIgnore> {
  const topOut = await git(root, ['rev-parse', '--show-toplevel'])
  const topRaw = topOut?.trim()
  if (!topRaw) return nestedMode()
  const top = await realpath(topRaw).catch(() => topRaw)
  if (await rootIsIgnored(top, root)) return nestedMode()
  const listed = await git(root, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '-z',
  ])
  if (listed === null) return nestedMode()
  return gitMode(listed.split('\0'))
}
