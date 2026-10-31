// Cuts a release of Fling: one version for the server, the web UI, the CLI, the MCP servers, the
// Claude Desktop extension and the plugin (docs/development.md, Releasing).
//
//   pnpm release <x.y.z> [--dry-run]   set the version in every VERSION_FILES entry and move the
//                                      CHANGELOG's Unreleased bullets under `## x.y.z (date)`
//   node scripts/release.mjs --check v<x.y.z>   exit 1 unless every version file says x.y.z
//   node scripts/release.mjs --notes v<x.y.z>   print that version's CHANGELOG section
//
// The release workflow (.github/workflows/release-cli.yml) runs --check and --notes on the tag, so
// the list of version files and the CHANGELOG's shape are defined here only. The pure functions
// are exported for scripts/release.test.mjs.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Every file that carries the release version, relative to the repository root. */
export const VERSION_FILES = [
  'package.json',
  'apps/cli/package.json',
  'apps/cli/mcpb/manifest.json',
  'plugin/.claude-plugin/plugin.json',
]

export const CHANGELOG = 'CHANGELOG.md'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** `x.y.z` as numbers; throws on anything else (no pre-release or build suffixes). */
export function parseVersion(version) {
  const match = SEMVER.exec(version)
  if (!match) throw new Error(`${version} is not a version (x.y.z)`)
  return match.slice(1, 4).map(Number)
}

/** Negative, zero or positive as `a` is lower than, equal to or higher than `b`. */
export function compareVersions(a, b) {
  const [pa, pb] = [parseVersion(a), parseVersion(b)]
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/** A tag `v<x.y.z>` (or a bare version) → `x.y.z`, checked. */
export function versionOfTag(tag) {
  const version = tag.replace(/^v/, '')
  parseVersion(version)
  return version
}

/**
 * The JSON text with its top-level `"version"` set, everything else byte for byte (the files are
 * formatted by hand or by Biome, so they are not re-serialised). The top-level key is the first
 * `"version"` in each of VERSION_FILES.
 */
export function setJsonVersion(text, version) {
  const pattern = /("version"\s*:\s*")[^"]*(")/
  if (!pattern.test(text)) throw new Error('no "version" key')
  const updated = text.replace(pattern, `$1${version}$2`)
  if (JSON.parse(updated).version !== version) throw new Error('"version" is not the top-level key')
  return updated
}

/** The lines of each `## ` section, by heading, in order. */
function sections(changelog) {
  const lines = changelog.split('\n')
  const found = []
  lines.forEach((line, index) => {
    if (line.startsWith('## ')) found.push({ heading: line.slice(3).trim(), start: index })
  })
  return found.map((section, i) => ({
    ...section,
    end: i + 1 < found.length ? found[i + 1].start : lines.length,
  }))
}

/** The body of the section whose heading `matches`, trimmed; null when there is none. */
function sectionBody(changelog, matches) {
  const section = sections(changelog).find(s => matches(s.heading))
  if (!section) return null
  return changelog
    .split('\n')
    .slice(section.start + 1, section.end)
    .join('\n')
    .trim()
}

const isVersionHeading = version => heading =>
  heading === version || heading.startsWith(`${version} (`)

/** The latest released version: the first `## x.y.z` heading. Null before the first release. */
export function latestReleased(changelog) {
  for (const { heading } of sections(changelog)) {
    const version = heading.split(' ')[0]
    if (SEMVER.test(version)) return version
  }
  return null
}

/**
 * The CHANGELOG with the Unreleased bullets moved under `## <version> (<date>)` and an empty
 * Unreleased left above it. Throws when Unreleased is missing or empty, or the version is there.
 */
export function cutChangelog(changelog, version, date) {
  const body = sectionBody(changelog, heading => heading === 'Unreleased')
  if (body === null) throw new Error(`${CHANGELOG} has no "## Unreleased" section`)
  if (body === '') throw new Error(`${CHANGELOG}'s Unreleased section is empty: nothing to release`)
  if (sectionBody(changelog, isVersionHeading(version)) !== null)
    throw new Error(`${CHANGELOG} already has a ${version} section`)
  const section = sections(changelog).find(s => s.heading === 'Unreleased')
  const lines = changelog.split('\n')
  return [
    ...lines.slice(0, section.start),
    '## Unreleased',
    '',
    `## ${version} (${date})`,
    '',
    body,
    '',
    ...lines.slice(section.end),
  ].join('\n')
}

/** The notes of one release: its CHANGELOG section's body. Throws when it has none. */
export function releaseNotes(changelog, version) {
  const body = sectionBody(changelog, isVersionHeading(version))
  if (!body) throw new Error(`${CHANGELOG} has no ${version} section`)
  return `${body}\n`
}

/** The files whose version is not `version`, as `file (has x.y.z)`. */
export function mismatchedFiles(versions, version) {
  return Object.entries(versions)
    .filter(([, has]) => has !== version)
    .map(([file, has]) => `${file} (has ${has})`)
}

const read = file => readFileSync(join(ROOT, file), 'utf8')
const versionsNow = () =>
  Object.fromEntries(VERSION_FILES.map(file => [file, JSON.parse(read(file)).version]))

function release(version, { dryRun }) {
  parseVersion(version)
  const versions = versionsNow()
  const current = Object.values(versions).reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))
  if (compareVersions(version, current) <= 0)
    throw new Error(`${version} is not greater than the current version, ${current}`)
  const date = new Date().toISOString().slice(0, 10)
  const changelog = cutChangelog(read(CHANGELOG), version, date)
  const writes = [
    ...VERSION_FILES.map(file => [file, setJsonVersion(read(file), version)]),
    [CHANGELOG, changelog],
  ]
  if (dryRun) {
    for (const [file] of writes) console.log(`would write ${file}`)
    console.log(`\n${releaseNotes(changelog, version)}`)
    return
  }
  for (const [file, text] of writes) writeFileSync(join(ROOT, file), text)
  console.log(`Fling ${version} (was ${current}): ${writes.map(([file]) => file).join(', ')}

Next:
  1. git switch -c release-${version} && git commit -am "Release ${version}"
  2. push, open a pull request, wait for the Gate check and merge it (gh pr merge --rebase)
  3. tag the release commit on main (its tip, unless something merged since) and push the tag;
     the Release workflow then publishes the CLI, creates the GitHub Release and deploys AWS:
       git fetch origin && git tag -a v${version} -m "Fling ${version}" origin/main
       git push origin v${version}
  4. deploy Cloudflare by hand from the same tag (Deploy (Cloudflare), ref v${version})`)
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      check: { type: 'string' },
      notes: { type: 'string' },
    },
  })
  if (values.check) {
    const version = versionOfTag(values.check)
    const wrong = mismatchedFiles(versionsNow(), version)
    if (wrong.length > 0) throw new Error(`${values.check} does not match ${wrong.join(', ')}`)
    console.log(`${VERSION_FILES.join(', ')}: ${version}`)
    return
  }
  if (values.notes) {
    process.stdout.write(releaseNotes(read(CHANGELOG), versionOfTag(values.notes)))
    return
  }
  if (positionals.length !== 1) throw new Error('usage: pnpm release <x.y.z> [--dry-run]')
  release(positionals[0], { dryRun: values['dry-run'] })
}

// Run, not imported (by the tests). realpath: a symlinked path (macOS's /var) names the same file.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    console.error(`release: ${error.message}`)
    process.exit(1)
  }
}
