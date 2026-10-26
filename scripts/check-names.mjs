// The de-branding gate (part of `pnpm lint`): Fling is instance-agnostic, so the only names of its
// publisher allowed in the repository are the npm package of the CLI and the GitHub repository
// (both defined for code in packages/shared/src/distribution.ts), and only in the files listed
// below. Instance values (domains, email allowlists, logos, colours) are configuration
// (platforms/aws/DEPLOY.md), never literals. A new use of either name: import the constant in code; add the
// file here only when it cannot import (a manifest, a doc, a workflow).
import { execFileSync } from 'node:child_process'
// Node strips the types; this script names neither itself.
import { CLI_PACKAGE as PACKAGE, REPO_SLUG as REPO } from '../packages/shared/src/distribution.ts'

const OWNER = REPO.split('/')[0]
const PUBLISHER = new RegExp(OWNER, 'i')

/** file → which of the two names it may contain. */
const ALLOWED = {
  // The definitions: code imports these, package.json publishes under it (a test keeps them equal).
  'packages/shared/src/distribution.ts': [PACKAGE, REPO],
  'apps/cli/package.json': [PACKAGE, REPO],
  // Manifests and docs that cannot import.
  'plugin/.mcp.json': [PACKAGE],
  'plugin/.claude-plugin/plugin.json': [REPO],
  '.claude-plugin/marketplace.json': [REPO],
  'apps/cli/mcpb/manifest.json': [REPO],
  'plugin/skills/fling/SKILL.md': [PACKAGE],
  'apps/cli/README.md': [PACKAGE, REPO],
  'README.md': [PACKAGE, REPO],
  '.github/workflows/release-cli.yml': [PACKAGE, REPO],
  // The "Why Fling?" page, a static site published with Fling itself.
  'why/index.html': [PACKAGE, REPO],
}

/** Matches that are neither name, by file and line pattern. */
const EXCEPTIONS = {
  // The README links to the "Why Fling?" deck where it is published.
  'README.md': [/^<https:\/\/why-fling\.fling\.labs\.[a-z]+\.com\/>$/],
}

let out = ''
try {
  const args = ['grep', '--untracked', '-n', '-I', '-i', OWNER, '--', '.', ':!pnpm-lock.yaml']
  out = execFileSync('git', args, { encoding: 'utf8' })
} catch (error) {
  if (error.status !== 1) throw error // 1 = no matches
}

const problems = []
for (const line of out.split('\n').filter(Boolean)) {
  const [file, lineNo, ...rest] = line.split(':')
  const text = rest.join(':')
  if (EXCEPTIONS[file]?.some(re => re.test(text.trim()))) continue
  const allowed = ALLOWED[file] ?? []
  // The package name contains the repo slug, so strip it first.
  let left = text
  for (const name of [PACKAGE, REPO]) {
    if (left.includes(name) && !allowed.includes(name)) {
      problems.push(
        `${file}:${lineNo}: "${name}" here — import it (packages/shared/src/distribution.ts)`
      )
    }
    left = left.replaceAll(name, '')
  }
  if (PUBLISHER.test(left)) problems.push(`${file}:${lineNo}: ${text.trim()}`)
}

if (problems.length) {
  console.error(
    'Instance-specific names found (Fling is instance-agnostic; see scripts/check-names.mjs):'
  )
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log('check-names: ok')
