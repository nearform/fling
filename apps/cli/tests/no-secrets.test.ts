/** Dotfiles, gitignored files, secret files and secrets are never flung (CLI + local MCP side). */
import { execFileSync } from 'node:child_process'
import { realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { runDeploy } from '../src/commands/deploy.ts'
import { prepareInput } from '../src/inputs.ts'
import {
  buildManifest,
  describeSkipped,
  SecretFilesError,
  SecretsFoundError,
} from '../src/manifest.ts'
import { createMcpServer } from '../src/mcp.ts'
import {
  captureError,
  jsonResponse,
  loggedInStore,
  mockFetch,
  runCleanups,
  site,
  tempDir,
  testContext,
  writeTree,
} from './helpers.ts'

afterEach(runCleanups)

// Assembled at runtime so the repo never contains a real-looking key.
const FAKE_AWS_KEY = `AKIA${'Q'.repeat(16)}`
const FAKE_GITHUB = `ghp_${'aB3xK9mQ2pL7'.repeat(3)}`

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

async function gitRepo(files: Record<string, string>) {
  const root = await realpath(await tempDir('fling-git-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  await writeTree(root, files)
  return root
}

const paths = (m: { files: { path: string }[] }) => m.files.map(f => f.path)

describe('dotfiles', () => {
  it('are skipped and reported (dot-dirs with a trailing slash; .git / .DS_Store quietly)', async () => {
    const root = await tempDir()
    await writeTree(root, {
      'index.html': 'x',
      '.env': 'A=1',
      '.dev.vars': 'A=1',
      '.npmrc': 'x',
      '.well-known/security.txt': 'x',
      '.git/config': 'x',
      '.DS_Store': 'x',
      'sub/.secret': 'x',
      'sub/ok.txt': 'x',
    })
    const m = await buildManifest(root)
    expect(paths(m)).toEqual(['index.html', 'sub/ok.txt'])
    expect(m.skipped.dotfiles).toEqual([
      '.dev.vars',
      '.env',
      '.npmrc',
      '.well-known/',
      'sub/.secret',
    ])
    expect(describeSkipped(m.skipped)).toEqual([
      'Skipped 5 dotfiles (.dev.vars, .env, .npmrc, .well-known/, sub/.secret) — dotfiles are never flung',
    ])
  })

  it('a symlink to a dotfile does not smuggle it in under another name', async () => {
    const root = await tempDir()
    await writeTree(root, { 'index.html': 'x', '.env': 'A=1' })
    await symlink(join(root, '.env'), join(root, 'env.txt'))
    const m = await buildManifest(root)
    expect(paths(m)).toEqual(['index.html'])
    expect(m.skipped.dotfiles).toEqual(['.env', 'env.txt'])
  })

  it('a single dotfile is refused outright', async () => {
    const root = await tempDir()
    await writeTree(root, { '.env': 'A=1', '.dev.vars': 'A=1' })
    for (const f of ['.env', '.dev.vars'])
      expect((await captureError(prepareInput(join(root, f)))).message).toMatch(/is a dotfile/)
  })

  it('a zip with .env inside: skipped and reported; macOS junk silently', async () => {
    const root = await tempDir()
    const zip = zipSync({
      'site/index.html': strToU8('<h1>x</h1>'),
      'site/.env': strToU8('A=1'),
      'site/.vscode/settings.json': strToU8('{}'),
      'site/.DS_Store': strToU8('x'),
      '__MACOSX/site/._index.html': strToU8('x'),
    })
    await writeFile(join(root, 'site.zip'), zip)
    const prepared = await prepareInput(join(root, 'site.zip'))
    try {
      expect(prepared.skippedDotfiles.sort()).toEqual(['site/.env', 'site/.vscode/'])
      expect(paths(await buildManifest(prepared.dir))).toEqual(['index.html'])
    } finally {
      await prepared.cleanup()
    }
  })
})

describe.skipIf(!hasGit)('gitignored files', () => {
  it('a tracked folder: everything git ignores is skipped and reported', async () => {
    const root = await gitRepo({
      '.gitignore': '*.log\nsecret-notes.txt\ncoverage/\n',
      'docs/index.html': 'x',
      'docs/debug.log': 'x',
      'docs/secret-notes.txt': 'x',
      'docs/coverage/index.html': 'x',
      'docs/.gitignore': 'drafts/\n',
      'docs/drafts/a.html': 'x',
      'docs/page.html': 'x',
    })
    const m = await buildManifest(join(root, 'docs'))
    expect(paths(m)).toEqual(['index.html', 'page.html'])
    expect(m.skipped.gitignored.sort()).toEqual([
      'coverage/',
      'debug.log',
      'drafts/',
      'secret-notes.txt',
    ])
    expect(describeSkipped(m.skipped)[1]).toMatch(
      /^Skipped 4 gitignored files \(.*\) — gitignored files are never flung$/
    )
  })

  it('the flung folder is itself ignored (dist/): only .gitignore files inside it apply', async () => {
    const root = await gitRepo({
      '.gitignore': 'dist/\n*.map\n',
      'src/app.ts': 'x',
      'dist/index.html': 'x',
      'dist/app.js': 'x',
      'dist/app.js.map': 'x', // ignored by the repo root's *.map — but dist/ is ignored as a whole
      'dist/.gitignore': 'private/\n',
      'dist/private/notes.html': 'x',
      'dist/assets/.gitignore': '*.tmp\n',
      'dist/assets/a.css': 'x',
      'dist/assets/b.tmp': 'x',
    })
    const m = await buildManifest(join(root, 'dist'))
    expect(paths(m)).toEqual(['app.js', 'app.js.map', 'assets/a.css', 'index.html'])
    expect(m.skipped.gitignored.sort()).toEqual(['assets/b.tmp', 'private/'])
  })

  it('a folder inside an ignored folder (build/site) is treated the same way', async () => {
    const root = await gitRepo({
      '.gitignore': 'build\n',
      'build/site/index.html': 'x',
      'build/site/a.js': 'x',
    })
    const m = await buildManifest(join(root, 'build', 'site'))
    expect(paths(m)).toEqual(['a.js', 'index.html'])
    expect(m.skipped.gitignored).toEqual([])
  })

  it('no git repo: .gitignore files inside the folder still apply', async () => {
    const root = await tempDir()
    await writeTree(root, { '.gitignore': '*.log\n', 'index.html': 'x', 'a.log': 'x' })
    const m = await buildManifest(root)
    expect(paths(m)).toEqual(['index.html'])
    expect(m.skipped.gitignored).toEqual(['a.log'])
  })
})

describe('secret files and secrets', () => {
  it('secret file names stop the fling, listing them', async () => {
    const root = await tempDir()
    await writeTree(root, {
      'index.html': 'x',
      'certs/server.key': 'x',
      id_rsa: 'x',
      'id_rsa.pub': 'ssh-rsa AAAA',
      'credentials/index.html': 'docs page about credentials',
    })
    const e = await captureError(buildManifest(root))
    expect(e).toBeInstanceOf(SecretFilesError)
    expect(e.paths).toEqual(['certs/server.key', 'id_rsa'])
    expect(e.message).toMatch(/secret files .*certs\/server\.key, id_rsa/)
  })

  it('.flingignore can leave a secret file out (it is then not flung)', async () => {
    const root = await tempDir()
    await writeTree(root, { 'index.html': 'x', 'server.pem': 'x', '.flingignore': '*.pem\n' })
    expect(paths(await buildManifest(root))).toEqual(['index.html'])
  })

  it('a single secret file is refused', async () => {
    const root = await tempDir()
    await writeTree(root, { 'server.pem': 'x' })
    expect(await captureError(prepareInput(join(root, 'server.pem')))).toBeInstanceOf(
      SecretFilesError
    )
  })

  it('secrets in contents stop the fling with file, line and kind — never the value', async () => {
    const root = await tempDir()
    await writeTree(root, {
      'index.html': `<h1>hi</h1>\n<script>const k = "${FAKE_AWS_KEY}"</script>`,
      'js/app.js': `// ok\n// ok\nfetch(u, { headers: { a: "${FAKE_GITHUB}" } })`,
      'img/logo.png': Buffer.from(FAKE_AWS_KEY), // binary format: not scanned
      'docs.html': 'AKIAIOSFODNN7EXAMPLE', // AWS's documented example
    })
    const e = await captureError(buildManifest(root))
    expect(e).toBeInstanceOf(SecretsFoundError)
    expect(e.exitCode).toBe(1)
    expect(e.findings).toEqual([
      { path: 'index.html', line: 2, rule: 'aws-access-key-id' },
      { path: 'js/app.js', line: 3, rule: 'github-token' },
    ])
    expect(e.message).toMatch(/index\.html line 2: AWS access key ID/)
    expect(e.message).toMatch(/js\/app\.js line 3: GitHub token/)
    expect(e.message).not.toContain(FAKE_AWS_KEY)
    expect(e.message).not.toContain(FAKE_GITHUB)
  })

  it('fling <dir> stops with exit 1 before any request', async () => {
    const root = await tempDir()
    await writeTree(root, { 'index.html': `x ${FAKE_AWS_KEY}` })
    const store = await loggedInStore()
    const m = mockFetch({})
    const { ctx } = await testContext({ store, fetch: m.fetch, json: true })
    const e = await captureError(runDeploy(ctx, root, { name: 'x', yes: true }))
    expect(e).toBeInstanceOf(SecretsFoundError)
    expect(m.calls).toHaveLength(0)
  })

  it('fling <dir> reports skipped files and includes them under --json', async () => {
    const root = await tempDir()
    await writeTree(root, { 'index.html': 'x', '.env': 'A=1' })
    const store = await loggedInStore()
    const m = mockFetch({
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse({ status: 'unchanged', versionId: 'abcdef0123456789', site: site() }),
    })
    const human = await testContext({ store, fetch: m.fetch })
    await runDeploy(human.ctx, root, { name: 'my-app', yes: true })
    expect(human.log.lines.join('\n')).toMatch(/Skipped 1 dotfile \(\.env\)/)
    const json = await testContext({ store, fetch: m.fetch, json: true })
    await runDeploy(json.ctx, root, { name: 'my-app', yes: true })
    expect(JSON.parse(json.out.content()).skipped).toEqual({ dotfiles: ['.env'], gitignored: [] })
  })

  it("the server's 422 secret_detected keeps its findings and gets a hint", async () => {
    const root = await tempDir()
    await writeTree(root, { 'index.html': 'x' })
    const store = await loggedInStore()
    const findings = [{ path: 'index.html', line: 1, rule: 'aws-access-key-id' }]
    const m = mockFetch({
      'POST /api/sites/my-app/deploys': () =>
        jsonResponse(
          {
            error: {
              code: 'secret_detected',
              message: 'Not published: found secrets in 1 file(s) — index.html line 1',
              findings,
            },
          },
          422
        ),
    })
    const { ctx } = await testContext({ store, fetch: m.fetch })
    const e = await captureError(runDeploy(ctx, root, { name: 'my-app', yes: true }))
    expect(e.code).toBe('secret_detected')
    expect(e.findings).toEqual(findings)
    expect(e.hint).toMatch(/Remove the secret/)
  })
})

describe('local MCP fling_publish', () => {
  async function connect(fetchImpl: ReturnType<typeof mockFetch>['fetch']) {
    const store = await loggedInStore()
    const home = await tempDir()
    const server = createMcpServer({
      store,
      fetch: fetchImpl,
      locate: { cwd: home, home, platform: process.platform, env: {} },
      waitReady: async () => ({ ready: true, waitedMs: 0 }),
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    return client
  }
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? ''

  it('refuses inline content with a secret, without calling the API', async () => {
    const m = mockFetch({})
    const client = await connect(m.fetch)
    const res = await client.callTool({
      name: 'fling_publish',
      arguments: {
        name: 'leaky',
        files: [{ path: 'index.html', content: `<p>${FAKE_AWS_KEY}</p>` }],
      },
    })
    expect(res.isError).toBe(true)
    expect(text(res)).toMatch(/found secrets in 1 file:\n {2}index\.html line 1: AWS access key ID/)
    expect(text(res)).not.toContain(FAKE_AWS_KEY)
    expect(m.calls).toHaveLength(0)
  })

  it('refuses secret file names and leaves dotfiles out (saying so)', async () => {
    const m = mockFetch({
      'POST /api/sites/ok/deploys': (_u, init) => {
        const files = JSON.parse(String(init.body)).manifest.files.map((f: any) => f.path)
        expect(files).toEqual(['index.html'])
        return jsonResponse({
          status: 'unchanged',
          versionId: 'abcdef0123456789',
          site: site({ name: 'ok' }),
        })
      },
    })
    const client = await connect(m.fetch)
    const secret = await client.callTool({
      name: 'fling_publish',
      arguments: {
        name: 'ok',
        files: [
          { path: 'index.html', content: 'x' },
          { path: 'server.key', content: 'x' },
        ],
      },
    })
    expect(secret.isError).toBe(true)
    expect(text(secret)).toMatch(/secret file .*server\.key/)

    const dot = await client.callTool({
      name: 'fling_publish',
      arguments: {
        name: 'ok',
        files: [
          { path: 'index.html', content: 'x' },
          { path: '.env', content: 'A=1' },
          { path: '.well-known/x.txt', content: 'x' },
        ],
      },
    })
    expect(dot.isError).toBeFalsy()
    expect(text(dot)).toMatch(/Skipped 2 dotfiles \(\.env, \.well-known\/x\.txt\)/)
  })
})
