// Bundle src/cli.ts → dist/cli.js: one ESM file with a node shebang. `@fling/shared` and
// `@fling/api` (workspace devDependencies consumed as TypeScript) are bundled in; every runtime
// dependency stays external so npm installs it.
//
// Beside it, for site servers: the package's `./server` export (the helpers a server imports) is
// the core's Node implementation of them, dist/helper.mjs, typed by dist/server.d.ts; and
// dist/entry.mjs is the core's Node entry that `fling dev` runs a server behind. Both .mjs files
// are the core's own (apps/api/src/servers/node), copied as they are: the local runtime
// (NodeSiteServers, bundled into cli.js) finds them next to the module it runs from.
import { chmod, copyFile, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const outfile = join(root, 'dist/cli.js')

await rm(join(root, 'dist'), { recursive: true, force: true })
await build({
  entryPoints: [join(root, 'src/cli.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  // Externalise each dependency and its subpaths (e.g. @modelcontextprotocol/sdk/server/mcp.js).
  external: Object.keys(pkg.dependencies ?? {}).flatMap(name => [name, `${name}/*`]),
  logLevel: 'warning',
})
await chmod(outfile, 0o755)
const node = join(root, '../api/src/servers/node')
await copyFile(join(node, 'entry.mjs'), join(root, 'dist/entry.mjs'))
await copyFile(join(node, 'helper.mjs'), join(root, 'dist/helper.mjs'))
await copyFile(join(root, 'src/server/index.d.ts'), join(root, 'dist/server.d.ts'))
console.log(`built ${outfile}`)
