// Bundle the Cloud Run service (the @fling/api core and the Node host with the GCP adapters):
// src/main.ts → dist/server/index.mjs, which the Dockerfile ships with the web build.
//
// The Google clients stay outside the bundle: they load their gRPC and REST definitions from
// files beside their own code at run time. dist/server/package.json names them at the versions
// this checkout's lockfile resolved, and the image installs exactly those.
//
// FLING_INSTANCE_CONFIG (optional): a JSON object of instance env keys (INSTANCE_NAME,
// ALLOWED_EMAIL_DOMAINS, BRAND_*, …) written beside the bundle as instance.json, which the service
// reads under its own environment. deploy-gcp.yml passes GCP_DEPLOY_CONFIG's `INSTANCE` object.
// MAIL_* and SES_* are refused there: email comes from the Terraform module's `mail` variable.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { parseInstanceConfig } from '../../aws/scripts/instance-config.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const outdir = `${root}dist/server`
const EXTERNAL = ['@google-cloud/firestore', '@google-cloud/storage', 'google-auth-library']

rmSync(`${root}dist`, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: [`${root}src/main.ts`],
  outfile: `${outdir}/index.mjs`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  external: EXTERNAL,
  sourcemap: false,
  legalComments: 'none',
  // Some CJS deps call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __flingCreateRequire } from 'node:module'; const require = __flingCreateRequire(import.meta.url);",
  },
  logLevel: 'info',
})

const require = createRequire(`${root}package.json`)
const versionOf = name => {
  const main = require.resolve(name)
  let dir = main.slice(
    0,
    main.lastIndexOf(`/node_modules/${name}/`) + `/node_modules/${name}/`.length
  )
  if (!dir.endsWith('/')) dir += '/'
  return JSON.parse(readFileSync(`${dir}package.json`, 'utf8')).version
}
writeFileSync(
  `${outdir}/package.json`,
  `${JSON.stringify(
    {
      name: 'fling-gcp-server',
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(EXTERNAL.map(name => [name, versionOf(name)])),
    },
    null,
    2
  )}\n`
)

const instance = process.env.FLING_INSTANCE_CONFIG?.trim()
if (instance) {
  const parsed = parseInstanceConfig(instance)
  writeFileSync(`${outdir}/instance.json`, `${JSON.stringify(parsed, null, 2)}\n`)
  console.log(`instance.json: ${Object.keys(parsed).join(', ')}`)
}
console.log('wrote dist/server')
