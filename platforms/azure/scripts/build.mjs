// Bundle the Container App's entry point (the @fling/api core and the Node host with the Azure
// adapters): src/main.ts → dist/main.mjs, the image's `node main.mjs` (Dockerfile, which adds the
// web build beside it).
//
// FLING_INSTANCE_CONFIG (optional): a JSON object of instance env keys (INSTANCE_NAME,
// ALLOWED_EMAIL_DOMAINS, BRAND_*, OIDC_*, …) written beside the bundle as instance.json, which
// main.ts reads under its own environment. deploy-azure.yml passes AZURE_DEPLOY_CONFIG's
// `INSTANCE` object. MAIL_* and SES_* are refused there: email comes from the Terraform `mail`
// variable, as on AWS.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { parseInstanceConfig } from '../../aws/scripts/instance-config.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const outdir = `${root}dist`

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: [`${root}src/main.ts`],
  outfile: `${outdir}/main.mjs`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  // Some CJS deps call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __flingCreateRequire } from 'node:module'; const require = __flingCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
})

const instance = process.env.FLING_INSTANCE_CONFIG?.trim()
if (instance) {
  const parsed = parseInstanceConfig(instance)
  writeFileSync(`${outdir}/instance.json`, `${JSON.stringify(parsed, null, 2)}\n`)
  console.log(`instance.json: ${Object.keys(parsed).join(', ')}`)
}
