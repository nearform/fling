import { describe, expect, it, vi } from 'vitest'
import { api } from '../src/lib/api'
import { fileUrl, hasRootIndex, sortForDisplay, splitPath } from '../src/lib/files'

describe('file list helpers', () => {
  it('splits folder and name', () => {
    expect(splitPath('index.html')).toEqual({ folder: '', name: 'index.html' })
    expect(splitPath('css/sub/app.css')).toEqual({ folder: 'css/sub/', name: 'app.css' })
  })

  it('groups root files first, then each folder together', () => {
    const sorted = sortForDisplay([
      { path: 'b.html' },
      { path: 'a/x.html' },
      { path: 'a.html' },
      { path: 'a/b/y.css' },
      { path: 'index.html' },
    ]).map(f => f.path)
    expect(sorted).toEqual(['a.html', 'b.html', 'index.html', 'a/x.html', 'a/b/y.css'])
  })

  it('detects a missing root index.html (a nested one does not count)', () => {
    expect(hasRootIndex([{ path: 'index.html' }])).toBe(true)
    expect(hasRootIndex([{ path: 'docs/index.html' }, { path: 'a.html' }])).toBe(false)
  })

  it('builds encoded file URLs', () => {
    expect(fileUrl('https://x.fling.test/', 'my docs/a b.html')).toBe(
      'https://x.fling.test/my%20docs/a%20b.html'
    )
    expect(fileUrl('https://x.fling.test', 'a.html')).toBe('https://x.fling.test/a.html')
  })
})

describe('api.versionFiles', () => {
  it('GETs the files endpoint and parses it', async () => {
    const body = {
      versionId: 'abc',
      files: [{ path: 'index.html', size: 3, contentType: 'text/html' }],
      totalBytes: 3,
      generatedIndex: false,
    }
    const fetchMock = vi.fn(
      async (_url: string) => new Response(JSON.stringify(body), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.versionFiles('my-site', 'abc')).resolves.toEqual(body)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sites/my-site/versions/abc/files')
    vi.unstubAllGlobals()
  })
})
