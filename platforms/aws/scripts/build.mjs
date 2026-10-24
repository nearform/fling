// Bundle the Lambda (the @fling/api core with the AWS adapters):
// src/lambda.ts → dist/lambda/index.mjs (handler `index.handler`) → dist/lambda.zip
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
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

execFileSync('zip', ['-q', '-r', '-X', '../lambda.zip', '.'], { cwd: outdir, stdio: 'inherit' })
console.log('wrote dist/lambda.zip')
