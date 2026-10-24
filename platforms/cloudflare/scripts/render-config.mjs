// Write dist/wrangler.jsonc, the deployable config, from wrangler.jsonc and CF_DEPLOY_CONFIG
// (the env var, or a file: `node scripts/render-config.mjs <deploy-config.json>`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, readJsonc, renderWranglerConfig, TEMPLATE } from './config.mjs'

const source = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : process.env.CF_DEPLOY_CONFIG
if (!source?.trim()) throw new Error('Pass a deploy config file, or set CF_DEPLOY_CONFIG')
const outDir = join(ROOT, 'dist')
mkdirSync(outDir, { recursive: true })
const rendered = renderWranglerConfig(readJsonc(TEMPLATE), JSON.parse(source), outDir)
const out = join(outDir, 'wrangler.jsonc')
writeFileSync(out, `${JSON.stringify(rendered, null, 2)}\n`)
console.log(
  `wrote ${out.replace(ROOT, '')}: ${rendered.name}, ${rendered.routes.map(r => r.pattern).join(' + ')}`
)
