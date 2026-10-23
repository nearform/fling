// Build the Claude Desktop extension: dist/fling.mcpb.
//
// 1. esbuild src/mcp-entry.ts into ONE self-contained ESM file (every dependency bundled — the
//    extension ships no node_modules) at dist/mcpb/server/index.mjs;
// 2. copy mcpb/manifest.json (its version set from package.json) and mcpb/icon.png next to it;
// 3. `mcpb validate` + `mcpb pack` (npx -y @anthropic-ai/mcpb) → dist/fling.mcpb.
//
// Run after `build` (which clears dist/); `build:mcpb` does both.
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const stage = join(root, 'dist/mcpb')
const out = join(root, 'dist/fling.mcpb')
const MCPB = ['-y', '@anthropic-ai/mcpb@^2']

await rm(stage, { recursive: true, force: true })
await rm(out, { force: true })
await mkdir(join(stage, 'server'), { recursive: true })

await build({
  entryPoints: [join(root, 'src/mcp-entry.ts')],
  outfile: join(stage, 'server/index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: true,
  legalComments: 'none',
  // Some bundled dependencies are CommonJS and call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __flingCreateRequire } from 'node:module'; const require = __flingCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
})

const manifest = JSON.parse(await readFile(join(root, 'mcpb/manifest.json'), 'utf8'))
manifest.version = pkg.version
await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await copyFile(join(root, 'mcpb/icon.png'), join(stage, 'icon.png'))

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const run = args => execFileSync(npx, [...MCPB, ...args], { stdio: 'inherit', cwd: root })
run(['validate', join(stage, 'manifest.json')])
run(['pack', stage, out])

const size = (await stat(out)).size
console.log(`built ${out} (${(size / 1024).toFixed(0)} KB)`)
