/**
 * The rules of `node scripts/docs-stale.mjs`: which Guide pages describe code that has moved
 * since somebody last checked them. Each page names, in its frontmatter, the code it describes
 * (`sources`, repository globs) and the commit it was last checked at (`verified`).
 *
 * A page is STALE when a file matching its `sources` changed after `verified`. Staleness is
 * reported, never fatal: a refactor is not held up by prose. STRUCTURAL errors are fatal: a page
 * whose frontmatter breaks the Guide's schema, a glob that matches nothing (the code it describes
 * has gone), or a `verified` git does not know.
 *
 * A commit that also touches the page counts as a check. `verified` cannot name the commit it is
 * written in, so the usual flow (change the code, run /doc-sync, move `verified` to HEAD, commit
 * both) would otherwise leave the page stale the moment it lands.
 *
 * Everything git-shaped goes through the `git` argument, so the rules are testable without a repo.
 */
import path from 'node:path'
// Node strips the types.
import {
  GuideFrontmatterSchema,
  isGuidePagePath,
  splitFrontmatter,
} from '../../packages/shared/src/guide.ts'

/** Repository-relative: where the Guide's pages live. */
export const GUIDE_CONTENT_PREFIX = 'apps/web/content/guide/'

/** @param {string} file */
export const isGuidePage = file =>
  file.startsWith(GUIDE_CONTENT_PREFIX) && isGuidePagePath(file.slice(GUIDE_CONTENT_PREFIX.length))

const freshness = GuideFrontmatterSchema.pick({ sources: true, verified: true })

/**
 * @typedef {{ path: string, added: number | null, deleted: number | null }} FileChange
 * @typedef {{ sha: string, files: FileChange[] }} CommitChanges
 * @typedef {{
 *   listFiles(): string[],
 *   readFile(file: string): string,
 *   resolveCommit(ref: string): string | null,
 *   commitsSince(sha: string): CommitChanges[],
 *   workingChanges(): FileChange[],
 * }} DocsGit
 * @typedef {{ doc: string, verified: string, files: FileChange[] }} StaleDoc
 * @typedef {{ doc: string, message: string }} DocError
 * @typedef {{ mode: 'history' | 'changed', checked: number, stale: StaleDoc[], errors: DocError[] }} DocsStaleReport
 */

/** @param {string} file @param {string[]} globs */
const matchesAny = (file, globs) => globs.some(g => path.matchesGlob(file, g))

/** Sum the rows per path; a null count (binary, untracked) stays null. @param {FileChange[]} changes */
function mergeChanges(changes) {
  /** @type {Map<string, FileChange>} */
  const byPath = new Map()
  for (const c of changes) {
    const prev = byPath.get(c.path)
    if (!prev) {
      byPath.set(c.path, { ...c })
      continue
    }
    prev.added = prev.added === null || c.added === null ? null : prev.added + c.added
    prev.deleted = prev.deleted === null || c.deleted === null ? null : prev.deleted + c.deleted
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * @param {DocsGit} git
 * @param {{ changed?: boolean }} [opts] `changed`: only what the working tree changed (the Stop hook)
 * @returns {DocsStaleReport}
 */
export function checkDocs(git, opts = {}) {
  const files = git.listFiles()
  const docs = files.filter(isGuidePage).sort()
  /** @type {DocError[]} */
  const errors = []
  /** @type {StaleDoc[]} */
  const stale = []
  const working = opts.changed ? git.workingChanges() : []
  const workingPaths = new Set(working.map(c => c.path))
  /** @type {Map<string, CommitChanges[]>} */
  const history = new Map()

  for (const doc of docs) {
    let data
    try {
      data = splitFrontmatter(git.readFile(doc)).data
    } catch (err) {
      errors.push({ doc, message: /** @type {Error} */ (err).message })
      continue
    }
    const parsed = freshness.safeParse(data)
    if (!parsed.success) {
      const fields = parsed.error.issues.map(i => i.path.join('.') || '(root)')
      errors.push({ doc, message: `bad or missing ${[...new Set(fields)].join(', ')}` })
      continue
    }
    const { sources, verified } = parsed.data
    for (const glob of sources) {
      if (!files.some(f => path.matchesGlob(f, glob))) {
        errors.push({ doc, message: `source glob matches no files: ${glob}` })
      }
    }
    const full = git.resolveCommit(verified)
    if (!full) {
      errors.push({ doc, message: `verified is not a known commit: ${verified}` })
      continue
    }

    /** @type {FileChange[]} */
    let changed
    if (opts.changed) {
      // The page is being edited alongside the code: that edit is the check.
      if (workingPaths.has(doc)) continue
      changed = working.filter(c => matchesAny(c.path, sources))
    } else {
      let commits = history.get(full)
      if (!commits) {
        commits = git.commitsSince(full)
        history.set(full, commits)
      }
      changed = commits
        .filter(commit => !commit.files.some(f => f.path === doc))
        .flatMap(commit => commit.files.filter(f => matchesAny(f.path, sources)))
    }
    if (changed.length > 0) stale.push({ doc, verified, files: mergeChanges(changed) })
  }

  return { mode: opts.changed ? 'changed' : 'history', checked: docs.length, stale, errors }
}

/** @param {FileChange} c */
const stat = c =>
  c.added === null || c.deleted === null ? 'new/binary' : `+${c.added} -${c.deleted}`

/**
 * What a person reads. Empty when there is nothing to say and `quiet` is set.
 * @param {DocsStaleReport} report
 * @param {{ quiet?: boolean }} [opts]
 */
export function formatReport(report, opts = {}) {
  const { stale, errors } = report
  if (opts.quiet && stale.length === 0 && errors.length === 0) return ''
  /** @type {string[]} */
  const lines = []
  if (report.mode === 'changed' && stale.length > 0) {
    lines.push(
      `These Guide pages describe code you changed: ${stale.map(s => s.doc).join(', ')}. Run /doc-sync before committing.`
    )
    for (const s of stale)
      for (const f of s.files) lines.push(`  ${s.doc} ← ${f.path} (${stat(f)})`)
  } else if (stale.length > 0) {
    lines.push(`${stale.length} stale Guide page(s): their sources changed after \`verified\`.`)
    for (const s of stale) {
      lines.push('', `${s.doc}  (verified ${s.verified})`)
      const width = Math.max(...s.files.map(f => f.path.length))
      for (const f of s.files) lines.push(`  ${f.path.padEnd(width)} | ${stat(f)}`)
    }
    lines.push('', 'Run /doc-sync to check them against the code and move `verified` on.')
  }
  if (errors.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`${errors.length} structural error(s):`)
    for (const e of errors) lines.push(`  ${e.doc}: ${e.message}`)
  }
  if (lines.length === 0) lines.push(`docs-stale: ${report.checked} page(s) checked, none stale.`)
  return lines.join('\n')
}

/** Structural errors fail; staleness alone does not. @param {DocsStaleReport} report */
export const exitCodeFor = report => (report.errors.length > 0 ? 1 : 0)

/** `git log --numstat --format=@@%H` → commits. @param {string} out */
export function parseNumstatLog(out) {
  /** @type {CommitChanges[]} */
  const commits = []
  /** @type {CommitChanges | null} */
  let current = null
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) {
      current = { sha: line.slice(2).trim(), files: [] }
      commits.push(current)
      continue
    }
    const row = parseNumstatLine(line)
    if (row && current) current.files.push(row)
  }
  return commits
}

/** One `added<TAB>deleted<TAB>path` row; `-` counts mean binary. @param {string} line */
export function parseNumstatLine(line) {
  const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
  if (!m) return null
  return {
    path: /** @type {string} */ (m[3]),
    added: m[1] === '-' ? null : Number(m[1]),
    deleted: m[2] === '-' ? null : Number(m[2]),
  }
}
