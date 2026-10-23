// Bundle src/cli.ts → dist/cli.js: one ESM file with a node shebang. `@fling/shared` (a workspace
// devDependency consumed as TypeScript) is bundled in; every runtime dependency stays external so
// npm installs it.
import { chmod, readFile, rm } from 'node:fs/promises'
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
  sourcemap: true,
  logLevel: 'warning',
})
await chmod(outfile, 0o755)
console.log(`built ${outfile}`)
