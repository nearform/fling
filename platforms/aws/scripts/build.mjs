// Bundle the Lambda (the @fling/api core with the AWS adapters):
// src/lambda.ts → dist/lambda/index.mjs (handler `index.handler`) → dist/lambda.zip
//
// FLING_INSTANCE_CONFIG (optional): a JSON object of instance env keys (INSTANCE_NAME,
// ALLOWED_EMAIL_DOMAINS, BRAND_*, …) written into the zip as instance.json, which the function
// reads under its own environment. deploy.yml passes AWS_DEPLOY_CONFIG's `INSTANCE` object.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const outdir = `${root}dist/lambda`

rmSync(`${root}dist`, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: [`${root}src/lambda.ts`],
  outfile: `${outdir}/index.mjs`,
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
  const parsed = JSON.parse(instance)
  const ok =
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.entries(parsed).every(
      ([k, v]) => /^[A-Z][A-Z0-9_]*$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)
    )
  if (!ok) throw new Error('FLING_INSTANCE_CONFIG must be a flat JSON object of ENV_STYLE keys')
  writeFileSync(`${outdir}/instance.json`, `${JSON.stringify(parsed, null, 2)}\n`)
  console.log(`instance.json: ${Object.keys(parsed).join(', ')}`)
}

execFileSync('zip', ['-q', '-r', '-X', '../lambda.zip', '.'], { cwd: outdir, stdio: 'inherit' })
console.log('wrote dist/lambda.zip')
