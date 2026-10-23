import { createHash } from 'node:crypto'
import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_DEPLOY_BYTES, MAX_FILE_BYTES } from '@fling/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { buildManifest, contentTypeFor, toManifest } from '../src/manifest.ts'
import { captureError, runCleanups, tempDir, writeTree } from './helpers.ts'

afterEach(runCleanups)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('buildManifest', () => {
  it('walks files with POSIX paths, hashes and sizes, sorted', async () => {
    const root = await tempDir()
    await writeTree(root, {
      'index.html': '<h1>hi</h1>',
      'assets/app.js': 'console.log(1)',
      'assets/img/logo.svg': '<svg/>',
    })
    const m = await buildManifest(root)
    expect(m.files.map(f => f.path)).toEqual(['assets/app.js', 'assets/img/logo.svg', 'index.html'])
    const index = m.files.find(f => f.path === 'index.html')
    expect(index).toMatchObject({
      sha256: sha('<h1>hi</h1>'),
      size: 11,
      contentType: 'text/html; charset=utf-8',
    })
    expect(m.totalBytes).toBe(11 + 14 + 6)
    expect(m.warnings).toEqual([])
    expect(toManifest(m).files[0]).not.toHaveProperty('absPath')
  })

  it('skips dotfiles, dot-dirs and node_modules', async () => {
    const root = await tempDir()
    await writeTree(root, {
      'index.html': 'x',
      '.env': 'SECRET=1',
      '.git/config': 'x',
      'node_modules/lib/index.js': 'x',
      'sub/node_modules/x.js': 'x',
      'sub/.DS_Store': 'x',
      'sub/ok.txt': 'x',
    })
    const m = await buildManifest(root)
    expect(m.files.map(f => f.path)).toEqual(['index.html', 'sub/ok.txt'])
  })

  it('honours .flingignore (gitignore syntax) and never ships it', async () => {
    const root = await tempDir()
    await writeTree(root, {
      '.flingignore': '*.map\ndrafts/\n!keep.map\n',
      'index.html': 'x',
      'app.js': 'x',
      'app.js.map': 'x',
      'keep.map': 'x',
      'drafts/a.html': 'x',
      'nested/drafts/b.html': 'x',
    })
    const m = await buildManifest(root)
    expect(m.files.map(f => f.path)).toEqual(['app.js', 'index.html', 'keep.map'])
  })

  it('follows symlinks inside the folder but never outside it', async () => {
    const outside = await tempDir()
    await writeTree(outside, { 'secret.txt': 'nope', 'dir/also.txt': 'nope' })
    const root = await tempDir()
    await writeTree(root, { 'index.html': 'x', 'real/a.txt': 'a' })
    await symlink(join(outside, 'secret.txt'), join(root, 'leak.txt'))
    await symlink(join(outside, 'dir'), join(root, 'leakdir'))
    await symlink(join(root, 'real/a.txt'), join(root, 'alias.txt'))
    await symlink(join(root, 'real'), join(root, 'real/loop'))
    await symlink(join(root, 'missing'), join(root, 'broken'))
    const m = await buildManifest(root)
    expect(m.files.map(f => f.path)).toEqual(['alias.txt', 'index.html', 'real/a.txt'])
    expect(m.warnings.join('\n')).toMatch(/outside the folder: leak\.txt/)
    expect(m.warnings.join('\n')).toMatch(/outside the folder: leakdir/)
    expect(m.warnings.join('\n')).toMatch(/broken symlink: broken/)
  })

  it('warns when there is no index.html at the root', async () => {
    const root = await tempDir()
    await writeTree(root, { 'sub/index.html': 'x' })
    const m = await buildManifest(root)
    expect(m.warnings).toEqual([expect.stringMatching(/No index\.html/)])
  })

  it('rejects an empty folder, a missing folder and a file', async () => {
    const root = await tempDir()
    await writeTree(root, { '.hidden': 'x', 'f.txt': 'x' })
    await mkdir(join(root, 'empty'))
    expect((await captureError(buildManifest(join(root, 'empty')))).message).toMatch(
      /Nothing to deploy/
    )
    expect((await captureError(buildManifest(join(root, 'nope')))).message).toMatch(/not found/)
    expect((await captureError(buildManifest(join(root, 'f.txt')))).message).toMatch(/Not a folder/)
  })

  it('enforces the per-file and per-deploy size limits', async () => {
    const big = await tempDir()
    await writeTree(big, { 'index.html': 'x', 'video.mp4': '' })
    await truncate(join(big, 'video.mp4'), MAX_FILE_BYTES + 1)
    const e1 = await captureError(buildManifest(big))
    expect(e1.message).toMatch(/video\.mp4 is .* the limit is 25 MB per file/)
    expect(e1.exitCode).toBe(1)

    const many = await tempDir()
    await writeTree(many, { 'index.html': 'x' })
    const per = MAX_FILE_BYTES - 1
    for (let i = 0; i < Math.ceil(MAX_DEPLOY_BYTES / per) + 1; i++) {
      await writeFile(join(many, `f${i}.bin`), '')
      await truncate(join(many, `f${i}.bin`), per)
    }
    expect((await captureError(buildManifest(many))).message).toMatch(/limit is 100 MB per deploy/)
  })
})

describe('contentTypeFor', () => {
  it('adds charset=utf-8 to text types and defaults to octet-stream', () => {
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8')
    expect(contentTypeFor('a/style.css')).toBe('text/css; charset=utf-8')
    expect(contentTypeFor('app.js')).toMatch(/^(text|application)\/javascript; charset=utf-8$/)
    expect(contentTypeFor('data.json')).toBe('application/json; charset=utf-8')
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml; charset=utf-8')
    expect(contentTypeFor('notes.txt')).toBe('text/plain; charset=utf-8')
    expect(contentTypeFor('photo.png')).toBe('image/png')
    expect(contentTypeFor('font.woff2')).toBe('font/woff2')
    expect(contentTypeFor('blob.unknownext')).toBe('application/octet-stream')
    expect(contentTypeFor('LICENSE')).toBe('application/octet-stream')
  })
})
