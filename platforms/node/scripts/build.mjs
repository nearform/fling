// Bundle a Fling process for Node (the core with the Node host's adapters) into one directory a
// container image copies whole:
//
//   dist/server/main.mjs      the entry, bundled by esbuild (every workspace package and dependency
//                             but EXTERNAL, inlined)
//   dist/server/entry.mjs,    the core's Node runtime for site servers (apps/api/src/servers/node),
//   dist/server/helper.mjs    which the bundle finds beside itself
//   dist/server/package.json  the external dependencies at the versions installed here, for
//                             `npm install --omit=dev` in the image
//
// The schema migrations (drizzle/) are not copied: the bundle reads `../../drizzle` from itself, as
// src/table/database.ts does from its own folder, so the image puts drizzle/ two levels above
// main.mjs (the Dockerfile: /app/drizzle beside /app/dist/server).
//
// Parameterised for the other platforms on Node (GCP, Azure), whose entry points import this
// package's host and adapters:
//
//   node scripts/build.mjs [--entry <file>] [--outdir <dir>]
//
// (default: src/main.ts into dist/server, relative to this package).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const { values: args } = parseArgs({
  options: {
    entry: { type: 'string', default: join(root, 'src', 'main.ts') },
    outdir: { type: 'string', default: join(root, 'dist', 'server') },
  },
})
const outdir = resolve(args.outdir)

/**
 * Left out of the bundle: PGlite loads its WebAssembly from beside its own module, so it is
 * installed in the image instead; the others are optional native add-ons nothing here installs.
 */
const INSTALLED = ['@electric-sql/pglite']
const OPTIONAL = ['pg-native', 'bufferutil', 'utf-8-validate']

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: [resolve(args.entry)],
  outfile: join(outdir, 'main.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  legalComments: 'none',
  external: [...INSTALLED, ...OPTIONAL],
  // Some CJS deps call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __flingCreateRequire } from 'node:module'; const require = __flingCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
})

const servers = join(root, '..', '..', 'apps', 'api', 'src', 'servers', 'node')
for (const file of ['entry.mjs', 'helper.mjs'])
  copyFileSync(join(servers, file), join(outdir, file))

const require = createRequire(join(root, 'package.json'))
const versionOf = name => {
  const main = require.resolve(name)
  for (let dir = dirname(main); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg.name === name) return pkg.version
    } catch {
      // not this folder
    }
  }
  throw new Error(`build: no version found for ${name}`)
}
const dependencies = Object.fromEntries(INSTALLED.map(name => [name, versionOf(name)]))
writeFileSync(
  join(outdir, 'package.json'),
  `${JSON.stringify({ name: 'fling-server', private: true, type: 'module', dependencies }, null, 2)}\n`
)
console.log(`wrote ${outdir} (main.mjs; installs ${Object.keys(dependencies).join(', ')})`)
