import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractZip,
  fileSiteName,
  prepareInput,
  unwrapSingleFolder,
  zipEntryPath,
} from '../src/inputs.ts'
import { captureError, runCleanups, tempDir, writeTree } from './helpers.ts'

afterEach(runCleanups)

async function listTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter(e => e.isFile())
    .map(e =>
      join(e.parentPath, e.name)
        .slice(dir.length + 1)
        .replaceAll('\\', '/')
    )
    .sort()
}

describe('file default names', () => {
  it('uses the file name without extension or duplicate suffix, slugified', () => {
    expect(fileSiteName('/Users/me/Downloads/Pitch Deck (1).html')).toBe('pitch-deck')
    expect(fileSiteName('C:\\Users\\me\\Downloads\\Q3 Report.zip')).toBe('q3-report')
    expect(fileSiteName('/x/diagram.svg')).toBe('diagram')
    expect(fileSiteName('/x/api.html')).toBe('api-site') // reserved → suffixed
  })
})

describe('prepareInput', () => {
  it('a folder is deployed as is, named by the folder algorithm', async () => {
    const root = await tempDir()
    await writeTree(join(root, 'report'), { 'index.html': 'x' })
    const p = await prepareInput(join(root, 'report'))
    expect(p).toMatchObject({ kind: 'folder', dir: join(root, 'report'), defaultName: 'report' })
  })

  it('a single .html file becomes index.html in a temp folder (cleaned up)', async () => {
    const root = await tempDir()
    await writeTree(root, { 'Pitch Deck (1).html': '<h1>deck</h1>' })
    const p = await prepareInput(join(root, 'Pitch Deck (1).html'))
    expect(p.kind).toBe('html')
    expect(p.defaultName).toBe('pitch-deck')
    expect(await listTree(p.dir)).toEqual(['index.html'])
    expect(await readFile(join(p.dir, 'index.html'), 'utf8')).toBe('<h1>deck</h1>')
    await p.cleanup()
    expect(existsSync(p.dir)).toBe(false)
  })

  it('another file is served next to a generated page that shows it', async () => {
    const root = await tempDir()
    await writeTree(root, { 'my diagram.svg': '<svg/>' })
    const p = await prepareInput(join(root, 'my diagram.svg'))
    expect(p).toMatchObject({ kind: 'file', defaultName: 'my-diagram' })
    expect(await listTree(p.dir)).toEqual(['index.html', 'my diagram.svg'])
    expect(await readFile(join(p.dir, 'index.html'), 'utf8')).toContain(
      '<img src="my%20diagram.svg"'
    )
    await p.cleanup()
  })

  it('a .zip is extracted: single top folder unwrapped, __MACOSX and dotfiles skipped', async () => {
    const root = await tempDir()
    const zip = zipSync({
      'site/index.html': strToU8('<h1>hi</h1>'),
      'site/css/app.css': strToU8('body{}'),
      'site/.DS_Store': strToU8('junk'),
      '__MACOSX/site/._index.html': strToU8('junk'),
    })
    await writeFile(join(root, 'My Site.zip'), zip)
    const p = await prepareInput(join(root, 'My Site.zip'))
    expect(p).toMatchObject({ kind: 'zip', defaultName: 'my-site' })
    expect(await listTree(p.dir)).toEqual(['css/app.css', 'index.html'])
    await p.cleanup()
  })
})

describe('zip extraction', () => {
  it('rejects zip-slip paths and writes nothing', async () => {
    for (const evil of ['../evil.html', 'a/../../evil.html', '/etc/evil', 'C:/evil.html']) {
      const dest = await tempDir()
      const zip = zipSync({ 'index.html': strToU8('ok'), [evil]: strToU8('bad') })
      const e = await captureError(extractZip(zip, dest))
      expect(e.message).toMatch(/escape/)
      expect(await readdir(dest)).toEqual([])
    }
  })

  it('classifies entry names', () => {
    expect(zipEntryPath('a\\b.html')).toBe('a/b.html')
    expect(zipEntryPath('./a.html')).toBe('a.html')
    expect(zipEntryPath('dir/')).toBeNull()
    expect(zipEntryPath('__MACOSX/x')).toBeNull()
    expect(zipEntryPath('a/.git/config')).toBeNull()
    expect(zipEntryPath('Thumbs.db')).toBeNull()
    expect(zipEntryPath('../x')).toBe('unsafe')
  })

  it('unwraps nested single folders only', () => {
    expect(unwrapSingleFolder(['a/b/index.html', 'a/b/x.css'])).toEqual(['index.html', 'x.css'])
    expect(unwrapSingleFolder(['a/index.html', 'b/x.css'])).toEqual(['a/index.html', 'b/x.css'])
    expect(unwrapSingleFolder(['a/index.html', 'top.html'])).toEqual(['a/index.html', 'top.html'])
  })

  it('reports an empty or corrupt zip', async () => {
    const dest = await tempDir()
    expect(
      (await captureError(extractZip(zipSync({ 'dir/': new Uint8Array() }), dest))).message
    ).toMatch(/no files/)
    expect((await captureError(extractZip(strToU8('not a zip'), dest))).message).toMatch(
      /Could not read the zip/
    )
  })
})
