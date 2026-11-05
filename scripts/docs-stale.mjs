/**
 * Which Guide pages describe code that changed after they were last checked (the rules are in
 * lib/docs-stale.mjs; this is the git adapter and the command). Paths are repository-relative
 * wherever it runs from.
 *
 *   node scripts/docs-stale.mjs              # history: commits since each page's `verified`
 *   node scripts/docs-stale.mjs --changed    # only the working tree and index against HEAD
 *   node scripts/docs-stale.mjs --json       # for /doc-sync
 *   node scripts/docs-stale.mjs --quiet      # nothing when clean
 *   node scripts/docs-stale.mjs --changed --quiet --hook   # the Claude Code Stop hook
 *
 * `--hook` prints `{"systemMessage": …}`: a Stop hook's plain output goes to the debug log, and
 * `systemMessage` shows the person a warning without blocking (asking Claude to continue instead
 * would re-trigger on every stop while a page is stale). It always exits 0: a reminder, never a
 * gate. Otherwise a structural error exits 1 and staleness alone exits 0. It needs full history,
 * so it is not part of `pnpm gate`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  checkDocs,
  exitCodeFor,
  formatReport,
  parseNumstatLine,
  parseNumstatLog,
} from './lib/docs-stale.mjs'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/** @param {...string} args */
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

/** @param {string} out */
const lines = out => out.split('\n').filter(Boolean)

/** @type {import('./lib/docs-stale.mjs').DocsGit} */
const realGit = {
  listFiles: () => lines(git('ls-files', '--cached', '--others', '--exclude-standard')),
  readFile: file => readFileSync(path.join(root, file), 'utf8'),
  resolveCommit: ref => {
    try {
      return git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).trim() || null
    } catch {
      return null
    }
  },
  commitsSince: sha =>
    parseNumstatLog(git('log', '--no-renames', '--numstat', '--format=@@%H', `${sha}..HEAD`)),
  workingChanges: () => [
    ...lines(git('diff', '--no-renames', '--numstat', 'HEAD'))
      .map(parseNumstatLine)
      .filter(c => c !== null),
    ...lines(git('ls-files', '--others', '--exclude-standard')).map(p => ({
      path: p,
      added: null,
      deleted: null,
    })),
  ],
}

const args = new Set(process.argv.slice(2))
const known = new Set(['--changed', '--json', '--quiet', '--hook'])
const unknown = [...args].filter(a => !known.has(a))
if (unknown.length > 0) {
  console.error(`docs-stale: unknown flag(s) ${unknown.join(', ')}; use ${[...known].join(', ')}`)
  process.exit(args.has('--hook') ? 0 : 2)
}

try {
  const report = checkDocs(realGit, { changed: args.has('--changed') })
  if (args.has('--hook')) {
    const text = formatReport(report, { quiet: true })
    if (text) console.log(JSON.stringify({ systemMessage: text }))
    process.exit(0)
  }
  if (args.has('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    const text = formatReport(report, { quiet: args.has('--quiet') })
    if (text) console.log(text)
  }
  process.exit(exitCodeFor(report))
} catch (err) {
  // The hook never fails a turn, even when git does.
  if (args.has('--hook')) process.exit(0)
  throw err
}
