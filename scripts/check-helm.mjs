// The Helm gate (part of `pnpm infra`, so of `pnpm gate`): every chart under
// `platforms/*/deploy/helm/*` passes `helm lint --strict` and renders with `helm template`, both
// with the chart's `ci/test-values.yaml` (placeholders for what the chart requires). Offline: it
// talks to no cluster.
//
// Without helm on PATH this skips with a notice, so the gate still passes on a laptop without it.
// In CI (CI=true; ci.yml installs it) a missing helm fails instead.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const dirsIn = dir =>
  existsSync(join(root, dir))
    ? readdirSync(join(root, dir), { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => `${dir}/${d.name}`)
        .sort()
    : []

const CHARTS = dirsIn('platforms')
  .flatMap(platform => dirsIn(`${platform}/deploy/helm`))
  .filter(chart => existsSync(join(root, chart, 'Chart.yaml')))

if (CHARTS.length === 0) {
  console.log('check-helm: no platforms/*/deploy/helm charts')
  process.exit(0)
}

if (spawnSync('helm', ['version'], { stdio: 'ignore' }).error) {
  if (process.env.CI) {
    console.error('check-helm: helm is not installed (ci.yml sets it up)')
    process.exit(1)
  }
  console.log(`check-helm: skipped, helm not found (install it to check ${CHARTS.join(', ')})`)
  process.exit(0)
}

const run = args => {
  try {
    execFileSync('helm', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  } catch (error) {
    console.error(`check-helm: helm ${args.join(' ')} failed`)
    console.error(`${error.stdout ?? ''}${error.stderr ?? ''}`)
    process.exit(1)
  }
}

for (const chart of CHARTS) {
  const values = join(chart, 'ci', 'test-values.yaml')
  const withValues = existsSync(join(root, values)) ? ['-f', values] : []
  run(['lint', '--strict', chart, ...withValues])
  run(['template', 'check', chart, ...withValues])
}
console.log(`check-helm: ok (lint and template ${CHARTS.join(', ')})`)
