// The rules of docs-stale (lib/docs-stale.mjs), against a fake git.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDocs, exitCodeFor, formatReport, parseNumstatLog } from './lib/docs-stale.mjs'

const PAGE = 'apps/web/content/guide/publish/deploy.md'
const page = (fields = {}) => {
  const fm = {
    title: 'Deploy',
    part: 'publish',
    order: 10,
    summary: 'Publish a folder.',
    sources: '[apps/cli/src/commands/**]',
    verified: 'aaaaaaa',
    ...fields,
  }
  return `---\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n\nBody.\n`
}

/** A repo with `files`, page text, known commits and the history since `aaaaaaa`. */
function fakeGit({ text = page(), commits = [], working = [], known = ['aaaaaaa'] } = {}) {
  return {
    listFiles: () => [PAGE, 'apps/cli/src/commands/deploy.ts', 'apps/web/content/guide/VOICE.md'],
    readFile: () => text,
    resolveCommit: ref => (known.includes(ref) ? `${ref}${'0'.repeat(33)}` : null),
    commitsSince: () => commits,
    workingChanges: () => working,
  }
}

const change = (path, added = 1, deleted = 0) => ({ path, added, deleted })

test('a page is fresh when nothing it describes changed', () => {
  const report = checkDocs(fakeGit({ commits: [{ sha: 'b', files: [change('README.md')] }] }))
  assert.equal(report.checked, 1)
  assert.deepEqual(report.stale, [])
  assert.equal(exitCodeFor(report), 0)
})

test('a page is stale when a source changed in a later commit, with the changes summed', () => {
  const report = checkDocs(
    fakeGit({
      commits: [
        { sha: 'b', files: [change('apps/cli/src/commands/deploy.ts', 3, 1)] },
        { sha: 'c', files: [change('apps/cli/src/commands/deploy.ts', 2, 2)] },
      ],
    })
  )
  assert.deepEqual(report.stale, [
    { doc: PAGE, verified: 'aaaaaaa', files: [change('apps/cli/src/commands/deploy.ts', 5, 3)] },
  ])
  assert.equal(exitCodeFor(report), 0, 'staleness alone does not fail')
})

test('a commit that also touches the page counts as a check', () => {
  const report = checkDocs(
    fakeGit({
      commits: [{ sha: 'b', files: [change('apps/cli/src/commands/deploy.ts'), change(PAGE)] }],
    })
  )
  assert.deepEqual(report.stale, [])
})

test('--changed looks at the working tree, and an edited page is taken as checked', () => {
  const working = [change('apps/cli/src/commands/deploy.ts')]
  assert.equal(checkDocs(fakeGit({ working }), { changed: true }).stale.length, 1)
  assert.equal(
    checkDocs(fakeGit({ working: [...working, change(PAGE)] }), { changed: true }).stale.length,
    0
  )
})

test('structural errors fail: bad frontmatter, a dead glob, an unknown commit', () => {
  for (const [git, message] of [
    [fakeGit({ text: 'no frontmatter' }), /frontmatter/],
    [fakeGit({ text: page({ sources: '[gone/**]' }) }), /matches no files: gone/],
    [fakeGit({ known: [] }), /not a known commit/],
    [fakeGit({ text: page({ verified: '' }) }), /verified/],
  ]) {
    const report = checkDocs(git)
    assert.equal(exitCodeFor(report), 1)
    assert.match(report.errors[0]?.message ?? '', message)
  }
})

test('VOICE.md and other files are not pages', () => {
  assert.equal(checkDocs(fakeGit()).checked, 1)
})

test('the hook text names the pages and asks for /doc-sync; quiet and clean says nothing', () => {
  const report = checkDocs(fakeGit({ working: [change('apps/cli/src/commands/deploy.ts')] }), {
    changed: true,
  })
  assert.match(formatReport(report, { quiet: true }), /deploy\.md.*\/doc-sync/)
  assert.equal(formatReport(checkDocs(fakeGit()), { quiet: true }), '')
})

test('parseNumstatLog reads commits and binary rows', () => {
  assert.deepEqual(parseNumstatLog('@@abc\n1\t2\ta.ts\n-\t-\tb.png\n\n@@def\n'), [
    { sha: 'abc', files: [change('a.ts', 1, 2), { path: 'b.png', added: null, deleted: null }] },
    { sha: 'def', files: [] },
  ])
})
