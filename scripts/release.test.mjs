// The pure parts of scripts/release.mjs: versions, the CHANGELOG cut and notes, the version files.
// Run by `pnpm test` (node --test).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  compareVersions,
  cutChangelog,
  latestReleased,
  mismatchedFiles,
  parseVersion,
  releaseNotes,
  setJsonVersion,
  VERSION_FILES,
  versionOfTag,
} from './release.mjs'

const CHANGELOG = `# Changelog

Header text.

## Unreleased

- **New thing.** It does this.

- **Other thing.** And that.

## 0.6.0

- An older entry.

## 0.5.1

- An even older one.
`

describe('versions', () => {
  it('accepts x.y.z only', () => {
    assert.deepEqual(parseVersion('0.7.0'), [0, 7, 0])
    assert.deepEqual(parseVersion('10.0.12'), [10, 0, 12])
    for (const bad of ['0.7', '0.7.0-rc.1', 'v0.7.0', '01.2.3', '1.2.3.4', ''])
      assert.throws(() => parseVersion(bad), /is not a version/)
  })

  it('orders numerically, not as text', () => {
    assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
    assert.ok(compareVersions('0.7.0', '0.7.1') < 0)
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  })

  it('reads a tag', () => {
    assert.equal(versionOfTag('v0.7.0'), '0.7.0')
    assert.equal(versionOfTag('0.7.0'), '0.7.0')
    assert.throws(() => versionOfTag('cli-v0.6.0'))
  })
})

describe('the CHANGELOG', () => {
  it('moves the Unreleased bullets under the new version and leaves Unreleased empty', () => {
    const cut = cutChangelog(CHANGELOG, '0.7.0', '2026-10-31')
    assert.equal(
      cut,
      `# Changelog

Header text.

## Unreleased

## 0.7.0 (2026-10-31)

- **New thing.** It does this.

- **Other thing.** And that.

## 0.6.0

- An older entry.

## 0.5.1

- An even older one.
`
    )
    assert.equal(latestReleased(cut), '0.7.0')
    assert.throws(() => cutChangelog(cut, '0.7.1', '2026-11-01'), /Unreleased section is empty/)
  })

  it('refuses a missing Unreleased section or a version it already has', () => {
    assert.throws(
      () => cutChangelog('# Changelog\n\n## 0.6.0\n\n- x\n', '0.7.0', '2026-10-31'),
      /no "## Unreleased"/
    )
    assert.throws(() => cutChangelog(CHANGELOG, '0.6.0', '2026-10-31'), /already has a 0.6.0/)
  })

  it('gives one release its section as notes, dated or not', () => {
    const cut = cutChangelog(CHANGELOG, '0.7.0', '2026-10-31')
    assert.equal(
      releaseNotes(cut, '0.7.0'),
      '- **New thing.** It does this.\n\n- **Other thing.** And that.\n'
    )
    assert.equal(releaseNotes(cut, '0.6.0'), '- An older entry.\n')
    assert.equal(releaseNotes(cut, '0.5.1'), '- An even older one.\n')
    assert.throws(() => releaseNotes(cut, '0.7.1'), /no 0.7.1 section/)
  })

  it("the repository's own CHANGELOG has an Unreleased section and a latest release", () => {
    const own = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
    assert.match(own, /^## Unreleased$/m)
    assert.ok(latestReleased(own))
  })
})

describe('version files', () => {
  it('sets the top-level version and keeps the rest of the text as it was', () => {
    const manifest = `{
  "manifest_version": "0.3",
  "name": "fling",
  "version": "0.6.0",
  "server": { "entry_point": "server/index.mjs" },
  "compatibility": { "runtimes": { "node": ">=20" } }
}
`
    assert.equal(setJsonVersion(manifest, '0.7.0'), manifest.replace('"0.6.0"', '"0.7.0"'))
    assert.throws(() => setJsonVersion('{ "name": "x" }', '0.7.0'), /no "version" key/)
    assert.throws(
      () => setJsonVersion('{ "dependencies": { "version": "1" } }', '0.7.0'),
      /not the top-level key/
    )
  })

  it("can set every one of the repository's version files", () => {
    for (const file of VERSION_FILES) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      assert.equal(JSON.parse(setJsonVersion(text, '99.0.0')).version, '99.0.0', file)
    }
  })

  it('names the files that do not carry a version', () => {
    assert.deepEqual(mismatchedFiles({ a: '0.7.0', b: '0.6.0' }, '0.7.0'), ['b (has 0.6.0)'])
    assert.deepEqual(mismatchedFiles({ a: '0.7.0' }, '0.7.0'), [])
  })
})
