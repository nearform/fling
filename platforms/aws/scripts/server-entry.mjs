// The runtime every site server's Web Function zip carries beside the author's bundle: src/servers/
// web-entry.ts bundled to index.mjs, and the core's entry.mjs and helper.mjs as they are (plain
// JavaScript, node:* only). build.mjs writes them into the API's own zip (dist/lambda/server-entry/),
// where the API reads them when it builds a revision's zip (src/servers/zip.ts); the tests build
// them into a temporary directory.
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)

/** The three files of the server runtime, written into `outdir`. */
export async function buildServerEntry(outdir) {
  mkdirSync(outdir, { recursive: true })
  await build({
    entryPoints: [`${root}src/servers/web-entry.ts`],
    outfile: `${outdir}/index.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
  })
  for (const name of ['entry', 'helper']) {
    copyFileSync(require.resolve(`@fling/api/servers/node/${name}`), `${outdir}/${name}.mjs`)
  }
}
