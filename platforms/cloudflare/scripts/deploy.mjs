// Deploy Fling to Cloudflare, in the order that never serves anything pointing at something
// missing. Used by .github/workflows/deploy-cloudflare.yml and by hand (DEPLOY.md):
//
//   1. dist/wrangler.jsonc from wrangler.jsonc + CF_DEPLOY_CONFIG (render-config.mjs);
//   2. dist/assets and a dry-run bundle check (build.mjs; build apps/web first);
//   3. the D1 schema: `wrangler d1 migrations apply --remote` (additive, before the code);
//   4. the Worker, its assets included: `wrangler deploy`;
//   5. Fling's data migrations (migrate.ts --remote), after the code, as on AWS;
//   6. the app origin's /.well-known/fling answers for this instance;
//   7. the smoke test (packages/e2e) when FLING_E2E_API_KEY is set, else a warning.
//
//   CF_DEPLOY_CONFIG='{…}' CLOUDFLARE_API_TOKEN=… node scripts/deploy.mjs [--skip-smoke]
//   node scripts/deploy.mjs --config-file deploy-config.json
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { checkDeployConfig, ROOT } from './config.mjs'

const { values: args } = parseArgs({
  options: {
    'config-file': { type: 'string' },
    'skip-smoke': { type: 'boolean', default: false },
  },
})

const raw = args['config-file']
  ? readFileSync(args['config-file'], 'utf8')
  : process.env.CF_DEPLOY_CONFIG
if (!raw?.trim()) {
  console.error('deploy: set CF_DEPLOY_CONFIG or pass --config-file (see DEPLOY.md)')
  process.exit(1)
}
const config = checkDeployConfig(JSON.parse(raw))
const appOrigin = config.APP_ORIGIN.replace(/\/$/, '')
const rendered = join(ROOT, 'dist', 'wrangler.jsonc')
const bin = name => join(ROOT, 'node_modules', '.bin', name)
const env = {
  ...process.env,
  CF_DEPLOY_CONFIG: JSON.stringify(config),
  CLOUDFLARE_ACCOUNT_ID: config.CLOUDFLARE_ACCOUNT_ID,
  FLING_WRANGLER_CONFIG: rendered,
  WRANGLER_SEND_METRICS: 'false',
}
const run = (title, cmd, argv) => {
  console.log(`\n▸ ${title}`)
  execFileSync(cmd, argv, { cwd: ROOT, stdio: 'inherit', env })
}

run('Render the Worker config', process.execPath, [join(ROOT, 'scripts', 'render-config.mjs')])
run('Build the assets and check the bundle', process.execPath, [join(ROOT, 'scripts', 'build.mjs')])
run('Apply the D1 schema', bin('wrangler'), [
  'd1',
  'migrations',
  'apply',
  'DB',
  '--remote',
  '--config',
  rendered,
])
run('Deploy the Worker', bin('wrangler'), ['deploy', '--config', rendered])
run('Run the data migrations', bin('tsx'), [
  join(ROOT, 'scripts', 'migrate.ts'),
  '--remote',
  '--config',
  rendered,
])

console.log('\n▸ Check the instance answers')
let answered = false
for (let attempt = 0; attempt < 20 && !answered; attempt++) {
  try {
    const res = await fetch(`${appOrigin}/.well-known/fling?deploy=${Date.now()}`, {
      headers: { 'cache-control': 'no-cache' },
    })
    const meta = res.ok ? await res.json() : null
    answered = meta?.appOrigin === appOrigin
    if (answered)
      console.log(JSON.stringify({ name: meta.name, appOrigin, sitesDomain: meta.sitesDomain }))
  } catch {
    // DNS or the certificate may still be settling on a first deploy
  }
  if (!answered) await new Promise(r => setTimeout(r, 6000))
}
if (!answered) {
  console.error(`deploy: ${appOrigin}/.well-known/fling did not answer for this instance`)
  process.exit(1)
}

if (args['skip-smoke']) {
  console.log('\nSmoke test skipped (--skip-smoke)')
} else if (!process.env.FLING_E2E_API_KEY) {
  console.warn(
    '\n! Smoke test skipped: set FLING_E2E_API_KEY (an API key of a test user, DEPLOY.md)'
  )
} else {
  run('Smoke test', bin('tsx'), [
    join(ROOT, '..', '..', 'packages', 'e2e', 'src', 'smoke.ts'),
    appOrigin,
  ])
}
console.log(`\nDeployed ${config.WORKER_NAME} to ${appOrigin}`)
