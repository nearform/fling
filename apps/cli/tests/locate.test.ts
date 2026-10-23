import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type FsEntry,
  findFiles,
  type LocateFs,
  type LocateOptions,
  resolveInput,
  searchRoots,
} from '../src/locate.ts'
import { captureError } from './helpers.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-23T12:00:00Z')

/** A fake filesystem from `{ path: ageInDays }` (files) — folders are implied by the paths. */
function fakeFs(
  files: Record<string, number>,
  platform: NodeJS.Platform = 'darwin',
  texts: Record<string, string> = {}
): LocateFs {
  const p = platform === 'win32' ? win32 : posix
  const norm = (x: string) => (platform === 'win32' ? x.toLowerCase() : x)
  const fileMap = new Map<string, number>()
  const dirs = new Map<string, Map<string, FsEntry>>()
  const addDir = (dir: string) => {
    if (!dirs.has(norm(dir))) dirs.set(norm(dir), new Map())
  }
  for (const [path, age] of Object.entries(files)) {
    fileMap.set(norm(path), NOW - age * DAY)
    let child = path
    let parent = p.dirname(path)
    let isFile = true
    while (parent !== child) {
      addDir(parent)
      const name = p.basename(child)
      dirs.get(norm(parent))?.set(name, { name, isFile, isDirectory: !isFile })
      isFile = false
      child = parent
      parent = p.dirname(parent)
    }
  }
  return {
    async stat(path) {
      const mtime = fileMap.get(norm(path))
      if (mtime !== undefined) return { isFile: true, isDirectory: false, mtimeMs: mtime, size: 10 }
      if (dirs.has(norm(path)))
        return { isFile: false, isDirectory: true, mtimeMs: NOW - 100 * DAY, size: 0 }
      return null
    },
    async readdir(path) {
      return [...(dirs.get(norm(path))?.values() ?? [])]
    },
    async readText(path) {
      return texts[path] ?? null
    },
  }
}

const mac = (files: Record<string, number>, extra: Partial<LocateOptions> = {}): LocateOptions => ({
  cwd: '/',
  home: '/Users/me',
  platform: 'darwin',
  env: {},
  fs: fakeFs(files),
  now: () => NOW,
  ...extra,
})

describe('resolveInput', () => {
  it('uses an existing path as given (absolute, relative to cwd, ~)', async () => {
    const opts = mac(
      { '/work/site/index.html': 1, '/Users/me/Downloads/a.html': 1 },
      { cwd: '/work' }
    )
    expect(await resolveInput('site', opts)).toMatchObject({
      path: '/work/site',
      foundIn: 'path',
      isDirectory: true,
    })
    expect(await resolveInput('/work/site/index.html', opts)).toMatchObject({
      path: '/work/site/index.html',
      foundIn: 'path',
    })
    expect(await resolveInput('~/Downloads/a.html', opts)).toMatchObject({
      path: '/Users/me/Downloads/a.html',
      foundIn: 'path',
    })
  })

  it('finds a bare file name in the current folder', async () => {
    const opts = mac({ '/work/proj/out/deck.html': 1 }, { cwd: '/work/proj' })
    expect(await resolveInput('deck.html', opts)).toMatchObject({
      path: '/work/proj/out/deck.html',
      foundIn: 'current folder',
    })
  })

  it('falls back to Downloads, newest first, including browser " (1)" duplicates', async () => {
    const opts = mac({
      '/Users/me/Downloads/Pitch Deck.html': 5,
      '/Users/me/Downloads/Pitch Deck (1).html': 1,
      '/Users/me/Desktop/old/Pitch Deck.html': 30,
    })
    const r = await resolveInput('Pitch Deck.html', opts)
    expect(r).toMatchObject({
      path: '/Users/me/Downloads/Pitch Deck (1).html',
      foundIn: 'Downloads',
    })
    expect(r.alternatives.map(a => a.path)).toEqual([
      '/Users/me/Downloads/Pitch Deck.html',
      '/Users/me/Desktop/old/Pitch Deck.html',
    ])
  })

  it('honours FLING_DOWNLOADS_DIR / downloadsDir', async () => {
    const files = { '/Volumes/data/dl/report.zip': 1 }
    expect(
      await resolveInput(
        'report.zip',
        mac(files, { env: { FLING_DOWNLOADS_DIR: '/Volumes/data/dl' } })
      )
    ).toMatchObject({ path: '/Volumes/data/dl/report.zip', foundIn: 'Downloads' })
    expect(
      await resolveInput('report.zip', mac(files, { downloadsDir: '/Volumes/data/dl' }))
    ).toMatchObject({ foundIn: 'Downloads' })
    // An unsubstituted mcpb placeholder is ignored.
    const roots = await searchRoots(
      mac({}, { env: { FLING_DOWNLOADS_DIR: `\${user_config.downloads_dir}` } })
    )
    expect(roots.find(r => r.label === 'Downloads')?.path).toBe('/Users/me/Downloads')
  })

  it('falls back from sandbox (VM) paths to a search by name, preferring matching parent folders', async () => {
    const outputs =
      '/Users/me/Library/Application Support/Claude/local-agent-mode-sessions/a/b/local_1/outputs'
    const opts = mac({
      [`${outputs}/site/index.html`]: 2,
      [`${outputs}/other/index.html`]: 1,
      [`${outputs}/x.html`]: 1,
    })
    expect(await resolveInput('/mnt/user-data/outputs/x.html', opts)).toMatchObject({
      path: `${outputs}/x.html`,
      foundIn: 'Claude Desktop outputs',
    })
    // Older, but its parent folder matches the input's.
    expect(await resolveInput('/sessions/abc/outputs/site/index.html', opts)).toMatchObject({
      path: `${outputs}/site/index.html`,
    })
  })

  it('not found: lists where it looked and flags sandbox paths', async () => {
    const e = await captureError(resolveInput('/mnt/user-data/outputs/nope.html', mac({})))
    expect(e.message).toMatch(/Could not find "\/mnt\/user-data\/outputs\/nope\.html"/)
    expect(e.message).toMatch(/Downloads \(\/Users\/me\/Downloads\)/)
    expect(e.message).toMatch(/Claude Desktop outputs/)
    expect(e.message).toMatch(/sandbox.*fling_publish/)
  })

  it('skips node_modules and dot-folders', async () => {
    const e = await captureError(
      resolveInput(
        'a.html',
        mac({
          '/Users/me/Downloads/node_modules/a.html': 1,
          '/Users/me/Downloads/.cache/a.html': 1,
        })
      )
    )
    expect(e.message).toMatch(/Could not find/)
  })

  it('handles Windows paths via the platform param', async () => {
    const opts: LocateOptions = {
      cwd: 'C:\\',
      home: 'C:\\Users\\me',
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
      fs: fakeFs(
        {
          'C:\\Users\\me\\Downloads\\deck.html': 1,
          'C:\\Users\\me\\AppData\\Roaming\\Claude\\local-agent-mode-sessions\\a\\b\\local_1\\outputs\\report.html': 1,
        },
        'win32'
      ),
      now: () => NOW,
    }
    expect(await resolveInput('deck.html', opts)).toMatchObject({
      path: 'C:\\Users\\me\\Downloads\\deck.html',
      foundIn: 'Downloads',
    })
    expect(await resolveInput('~\\Downloads\\deck.html', opts)).toMatchObject({ foundIn: 'path' })
    expect(await resolveInput('report.html', opts)).toMatchObject({
      foundIn: 'Claude Desktop outputs',
    })
    const roots = await searchRoots(opts)
    expect(roots.map(r => [r.label, r.path])).toEqual([
      ['Downloads', 'C:\\Users\\me\\Downloads'],
      ['Desktop', 'C:\\Users\\me\\Desktop'],
      ['Documents/Claude', 'C:\\Users\\me\\Documents\\Claude'],
      ['~/Claude', 'C:\\Users\\me\\Claude'],
      [
        'Claude Desktop outputs',
        'C:\\Users\\me\\AppData\\Roaming\\Claude\\local-agent-mode-sessions',
      ],
    ])
  })

  it('Linux: XDG user-dirs for Downloads and Desktop', async () => {
    const opts: LocateOptions = {
      cwd: '/home/me/proj',
      home: '/home/me',
      platform: 'linux',
      env: {},
      fs: fakeFs({}, 'linux', {
        '/home/me/.config/user-dirs.dirs':
          'XDG_DESKTOP_DIR="$HOME/Bureau"\nXDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n',
      }),
    }
    const roots = await searchRoots(opts)
    expect(roots.map(r => r.path)).toEqual([
      '/home/me/proj',
      '/home/me/Téléchargements',
      '/home/me/Desktop'.replace('Desktop', 'Bureau'),
      '/home/me/Documents/Claude',
      '/home/me/Claude',
      '/home/me/.config/Claude/local-agent-mode-sessions',
    ])
    const env = await searchRoots({ ...opts, env: { XDG_DOWNLOAD_DIR: '/data/dl' } })
    expect(env[1]?.path).toBe('/data/dl')
  })
})

describe('findFiles', () => {
  it('lists recent html/zip files and site folders newest first, within the window', async () => {
    const outputs =
      '/Users/me/Library/Application Support/Claude/local-agent-mode-sessions/a/b/local_1/outputs'
    const opts = mac({
      '/Users/me/Downloads/deck.html': 3,
      '/Users/me/Downloads/site.zip': 1,
      '/Users/me/Downloads/notes.txt': 0,
      '/Users/me/Downloads/old.html': 40,
      '/Users/me/Desktop/mysite/index.html': 2,
      '/Users/me/Desktop/mysite/about.html': 0,
      [`${outputs}/report.html`]: 0.5,
    })
    const { files } = await findFiles(opts)
    expect(files.map(f => [f.path, f.kind, f.foundIn])).toEqual([
      [`${outputs}/report.html`, 'file', 'Claude Desktop outputs'],
      ['/Users/me/Downloads/site.zip', 'file', 'Downloads'],
      ['/Users/me/Desktop/mysite', 'folder', 'Desktop'],
      ['/Users/me/Downloads/deck.html', 'file', 'Downloads'],
    ])
    expect((await findFiles(opts, { query: 'DECK' })).files.map(f => f.path)).toEqual([
      '/Users/me/Downloads/deck.html',
    ])
    expect((await findFiles(opts, { days: 60, limit: 2 })).files).toHaveLength(2)
    expect((await findFiles(opts, { days: 60 })).files.map(f => f.path)).toContain(
      '/Users/me/Downloads/old.html'
    )
  })
})
