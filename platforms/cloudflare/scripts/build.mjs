// Build what the Worker deploys besides its code:
//   dist/assets/            the web UI (apps/web/dist), `_fling/404.html` (the sites' 404 page,
//                           apps/web/dist-404) and `downloads/fling.mcpb` when apps/cli built it;
// then bundle the Worker as `wrangler deploy --dry-run` would (dist/worker/) and check the bundle:
// no AWS SDK, and under the Workers size limit. No account is needed. `--assets-only` stops after
// the assets (local dev, the e2e). FLING_WRANGLER_CONFIG checks another config (the rendered one).
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const repo = join(root, '..', '..')
const assets = join(root, 'dist', 'assets')
const web = join(repo, 'apps', 'web', 'dist')
const page404 = join(repo, 'apps', 'web', 'dist-404', '404.html')
const mcpb = join(repo, 'apps', 'cli', 'dist', 'fling.mcpb')

for (const [path, what] of [
  [join(web, 'index.html'), 'the web UI'],
  [page404, "the sites' 404 page"],
]) {
  if (!existsSync(path))
    throw new Error(`${path} is missing: build ${what} first (pnpm --filter @fling/web build)`)
}

rmSync(assets, { recursive: true, force: true })
rmSync(join(root, 'dist', 'worker'), { recursive: true, force: true })
mkdirSync(assets, { recursive: true })
cpSync(web, assets, { recursive: true })
mkdirSync(join(assets, '_fling'), { recursive: true })
cpSync(page404, join(assets, '_fling', '404.html'))
if (existsSync(mcpb)) {
  mkdirSync(join(assets, 'downloads'), { recursive: true })
  cpSync(mcpb, join(assets, 'downloads', 'fling.mcpb'))
}
console.log(`dist/assets: ${readdirSync(assets).join(', ')}`)
if (process.argv.includes('--assets-only')) process.exit(0)

const config = process.env.FLING_WRANGLER_CONFIG ?? join(root, 'wrangler.jsonc')
execFileSync(
  join(root, 'node_modules', '.bin', 'wrangler'),
  ['deploy', '--dry-run', '--config', config, '--outdir', join(root, 'dist', 'worker')],
  {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  }
)
const bundle = join(root, 'dist', 'worker', 'worker.js')
const code = readFileSync(bundle, 'utf8')
for (const banned of ['@aws-sdk', '@smithy/']) {
  if (code.includes(banned)) throw new Error(`the Worker bundle contains ${banned}`)
}
const mb = statSync(bundle).size / 1024 / 1024
console.log(`dist/worker/worker.js: ${mb.toFixed(2)} MB (uncompressed)`)
if (mb > 10) throw new Error('the Worker bundle is over 10 MB')
