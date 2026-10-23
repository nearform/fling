/**
 * The default site name for a folder. Site names are one global namespace, so the name should say
 * which project the folder belongs to — `~/work/rocketpod/docs` is `rocketpod-docs`, not `docs` —
 * and never include the user's name.
 *
 * 1. Project root: the nearest ancestor (the folder itself included) containing `.git`; failing
 *    that, the nearest containing a package manifest (PROJECT_MARKERS). The search stops below the
 *    home directory and the filesystem root, which are never a project root.
 * 2. With a root: the root's folder name, then each path segment from the root down to the folder,
 *    skipping BUILD_OUTPUT_DIRS, CONTAINER_DIRS, dot-directories (`.vitepress`, `.next`…) and
 *    repeats (a segment equal to the root name or the previous kept segment). A build-suffix
 *    (`storybook-static`, `docs-dist`…) is trimmed off a segment (`storybook`).
 *    Without a root: just the deepest segment below home that is not a build-output / dot dir
 *    (`~/Downloads/report/dist` → `report`).
 * 3. Slugify each part and join with `-`. Over SITE_NAME_MAX: drop middle parts (keeping the
 *    first and last), then truncate; never ends in `-`. A reserved or otherwise invalid result
 *    gets `-site` appended (`api` → `api-site`).
 *
 * Pure apart from the injectable `exists` check (tests pass a fake filesystem).
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { isValidSiteName, SITE_NAME_MAX, slugify } from '@fling/shared'

/** Files that mark a project root when there is no `.git` above the folder. */
export const PROJECT_MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'] as const

/** Build-output folder names: they say nothing about what the site is. */
export const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set([
  'dist',
  'build',
  'out',
  'output',
  'public',
  'www',
  '_site',
  'site',
  'html',
  'static',
  'export',
  'target',
])

/** Monorepo / source container folders: the interesting name is the one below them. */
export const CONTAINER_DIRS: ReadonlySet<string> = new Set([
  'apps',
  'packages',
  'src',
  'sites',
  'libs',
  'projects',
  'services',
])

/** Trimmed off the end of a segment: `storybook-static` → `storybook`, `docs-dist` → `docs`. */
const BUILD_SUFFIX_RE = /[-_.](static|dist|build|out|output)$/i

const FALLBACK_NAME = 'my-site'

export interface NamingEnv {
  /** Does this absolute path exist (file or directory)? */
  exists?: (path: string) => boolean
  /** Home directory: the root search stops below it. */
  home?: string
}

/** Nearest ancestor with `.git`, else with a PROJECT_MARKERS file; null when there is none. */
export function findProjectRoot(dir: string, env: NamingEnv = {}): string | null {
  const exists = env.exists ?? existsSync
  const home = resolve(env.home ?? homedir())
  const candidates: string[] = []
  for (let d = resolve(dir); d !== home && dirname(d) !== d; d = dirname(d)) candidates.push(d)
  return (
    candidates.find(d => exists(`${d}${sep}.git`)) ??
    candidates.find(d => PROJECT_MARKERS.some(m => exists(`${d}${sep}${m}`))) ??
    null
  )
}

const isGeneric = (segment: string) =>
  segment.startsWith('.') || BUILD_OUTPUT_DIRS.has(segment.toLowerCase())

/** The name parts for a folder, before slugifying and fitting (see the module comment). */
export function nameParts(dir: string, env: NamingEnv = {}): string[] {
  const abs = resolve(dir)
  const root = findProjectRoot(abs, env)
  if (!root) {
    // Only segments below home, so the home folder (often the user's name) never leaks in.
    const fromHome = relative(resolve(env.home ?? homedir()), abs)
    if (fromHome === '') return []
    const underHome = fromHome && !fromHome.startsWith('..') && !isAbsolute(fromHome)
    const segments = (underHome ? fromHome : abs).split(sep).filter(Boolean)
    const pick = [...segments].reverse().find(s => !isGeneric(s)) ?? segments.at(-1)
    return pick ? [pick] : []
  }
  const parts = [basename(root)]
  const rel = relative(root, abs)
  for (const raw of rel ? rel.split(sep) : []) {
    if (isGeneric(raw) || CONTAINER_DIRS.has(raw.toLowerCase())) continue
    const segment = raw.replace(BUILD_SUFFIX_RE, '')
    const slug = slugify(segment, 200)
    if (!slug || slug === slugify(parts[0] ?? '', 200)) continue
    if (slug === slugify(parts.at(-1) ?? '', 200)) continue
    parts.push(segment)
  }
  return parts
}

/** Join slugified parts within SITE_NAME_MAX: drop middle parts first, then truncate. */
export function fitName(parts: string[]): string {
  const slugs = parts.map(p => slugify(p, 200)).filter(Boolean)
  while (slugs.length > 2 && slugs.join('-').length > SITE_NAME_MAX) slugs.splice(1, 1)
  let name = slugify(slugs.join('-'))
  if (!name) return FALLBACK_NAME
  if (!isValidSiteName(name)) {
    name = `${name.slice(0, SITE_NAME_MAX - 5).replace(/-+$/, '')}-site`
  }
  return isValidSiteName(name) ? name : FALLBACK_NAME
}

/** Default site name for a folder, e.g. `~/work/rocketpod/docs` → `rocketpod-docs`. */
export function defaultSiteName(dir: string, env: NamingEnv = {}): string {
  return fitName(nameParts(dir, env))
}
