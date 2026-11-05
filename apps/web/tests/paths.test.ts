/**
 * Paths in the web UI: the API calls behind the Path page, the site page's list of Paths (search,
 * order and rows), and what the Path page offers: restore to those who publish to it, the role
 * editors and archive or delete to its owners and the site's.
 */
import type { PathDetail, SitePath } from '@fling/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PathDangerZone } from '../src/components/site/PathDangerZone'
import { PathTeam } from '../src/components/site/PathTeam'
import { PathVersions } from '../src/components/site/PathVersions'
import { PathsTable, publishPathCommand } from '../src/components/site/SitePaths'
import { api } from '../src/lib/api'
import {
  canManagePath,
  canRestorePath,
  DEFAULT_PATH_SORT,
  filterPaths,
  membersSummary,
  parsePathSort,
  pathHref,
  pathsCountLabel,
  sortPaths,
} from '../src/lib/paths'

const SITE_URL = 'https://plans.sites.example.test/'

const sitePath = (over: Partial<SitePath> = {}): SitePath => ({
  folder: 'PAY-412',
  title: 'Payments plan',
  url: `${SITE_URL}PAY-412/`,
  currentVersionId: 'v2-aaaaaaaaaaaa',
  archived: false,
  owners: { emails: [{ email: 'sam@example.test', known: true }], groups: [] },
  publishers: { emails: [], groups: [] },
  createdBy: 'sam@example.test',
  canPublish: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  ...over,
})

const pathDetail = (over: Partial<PathDetail> = {}): PathDetail => ({
  ...sitePath(),
  versions: [
    {
      id: 'v2-aaaaaaaaaaaa',
      fileCount: 3,
      totalBytes: 2048,
      path: 'PAY-412',
      createdAt: '2026-11-01T10:00:00.000Z',
    },
    {
      id: 'v1-bbbbbbbbbbbb',
      fileCount: 2,
      totalBytes: 1024,
      publishedBy: 'sam@example.test',
      path: 'PAY-412',
      createdAt: '2026-10-01T10:00:00.000Z',
    },
  ],
  ...over,
})

function respond(status: number, body?: unknown) {
  const fetchMock = vi.fn(
    async () => new Response(body === undefined ? null : JSON.stringify(body), { status })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The method, URL and JSON body of the last request. */
function lastRequest(fetchMock: ReturnType<typeof respond>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
  return {
    url,
    method: init.method,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
  }
}

function render(node: ReactNode): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(StaticRouter, { location: '/sites/plans' }, node)
    )
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the Paths API', () => {
  it("lists a site's Paths", async () => {
    const fetchMock = respond(200, { paths: [sitePath()] })
    await expect(api.listPaths('plans')).resolves.toMatchObject([{ folder: 'PAY-412' }])
    expect(lastRequest(fetchMock)).toMatchObject({ url: '/api/sites/plans/paths', method: 'GET' })
  })

  it('reads one Path with its versions', async () => {
    const fetchMock = respond(200, pathDetail())
    const detail = await api.getPath('plans', 'PAY-412')
    expect(detail.versions.map(v => v.id)).toEqual(['v2-aaaaaaaaaaaa', 'v1-bbbbbbbbbbbb'])
    expect(lastRequest(fetchMock).url).toBe('/api/sites/plans/paths/PAY-412')
  })

  it('restores a version of the Path alone', async () => {
    const fetchMock = respond(200, sitePath({ currentVersionId: 'v1-bbbbbbbbbbbb' }))
    const path = await api.setPathVersion('plans', 'PAY-412', 'v1-bbbbbbbbbbbb')
    expect(path.currentVersionId).toBe('v1-bbbbbbbbbbbb')
    expect(lastRequest(fetchMock)).toEqual({
      url: '/api/sites/plans/paths/PAY-412/current',
      method: 'POST',
      body: { versionId: 'v1-bbbbbbbbbbbb' },
    })
  })

  it("replaces the Path's owners or publishers, and archives it, with PATCH", async () => {
    const fetchMock = respond(200, sitePath())
    await api.updatePath('plans', 'PAY-412', { owners: { emails: ['ana@example.test'] } })
    expect(lastRequest(fetchMock)).toEqual({
      url: '/api/sites/plans/paths/PAY-412',
      method: 'PATCH',
      body: { owners: { emails: ['ana@example.test'] } },
    })
    await api.updatePath('plans', 'PAY-412', { archived: true })
    expect(lastRequest(fetchMock).body).toEqual({ archived: true })
  })

  it('deletes a Path, and fetches a Path version’s files by its folder', async () => {
    const fetchMock = respond(204)
    await api.deletePath('plans', 'PAY-412')
    expect(lastRequest(fetchMock)).toMatchObject({
      url: '/api/sites/plans/paths/PAY-412',
      method: 'DELETE',
    })
    respond(200, { versionId: 'v1', files: [], totalBytes: 0, generatedIndex: false })
    await api.versionFiles('plans', 'v1', 'PAY-412')
    expect(lastRequest(fetch as unknown as ReturnType<typeof respond>).url).toBe(
      '/api/sites/plans/versions/v1/files?path=PAY-412'
    )
  })
})

describe("the site page's list of Paths", () => {
  const paths = [
    sitePath({ folder: 'b-plan', title: 'Beta', updatedAt: '2026-10-05T00:00:00.000Z' }),
    sitePath({
      folder: 'a-plan',
      title: 'Alpha',
      owners: { emails: [], groups: [{ slug: 'design', name: 'Design team', size: 4 }] },
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    }),
    sitePath({ folder: 'c-plan', title: '', updatedAt: '2026-10-09T00:00:00.000Z' }),
  ]

  it('links each Path to its page under the site', () => {
    expect(pathHref('plans', 'PAY-412')).toBe('/sites/plans/paths/PAY-412')
  })

  it('orders newest first by default, or by folder A–Z', () => {
    expect(parsePathSort(null)).toBe(DEFAULT_PATH_SORT)
    expect(parsePathSort('nonsense')).toBe(DEFAULT_PATH_SORT)
    expect(sortPaths(paths, parsePathSort(null)).map(p => p.folder)).toEqual([
      'c-plan',
      'b-plan',
      'a-plan',
    ])
    expect(sortPaths(paths, 'folder').map(p => p.folder)).toEqual(['a-plan', 'b-plan', 'c-plan'])
    expect(sortPaths(paths, 'updated').map(p => p.folder)).toEqual(['c-plan', 'b-plan', 'a-plan'])
    expect(sortPaths(paths, 'created')[0]?.folder).toBe('a-plan')
  })

  it('searches the folder, title and owners', () => {
    expect(filterPaths(paths, 'beta').map(p => p.folder)).toEqual(['b-plan'])
    expect(filterPaths(paths, 'design').map(p => p.folder)).toEqual(['a-plan'])
    expect(filterPaths(paths, '  ')).toHaveLength(paths.length)
    expect(pathsCountLabel(3, 1, true)).toBe('1 of 3 Paths')
    expect(pathsCountLabel(1, 1, false)).toBe('1 Path')
  })

  it('sums up owners in a line', () => {
    expect(membersSummary(paths[1]?.owners)).toBe('Design team')
    expect(
      membersSummary({
        emails: ['a', 'b', 'c'].map(n => ({ email: `${n}@example.test`, known: true })),
        groups: [],
      })
    ).toBe('a@example.test, b@example.test +1')
    expect(membersSummary(undefined)).toBe('')
  })

  it('shows each Path with its link, title, state and owners', () => {
    const html = render(
      createElement(PathsTable, {
        name: 'plans',
        paths: [
          sitePath(),
          sitePath({ folder: 'old', archived: true }),
          sitePath({ folder: 'draft', currentVersionId: null, owners: { emails: [], groups: [] } }),
        ],
      })
    )
    expect(html).toContain('href="/sites/plans/paths/PAY-412"')
    expect(html).toContain('/PAY-412/')
    expect(html).toContain('Payments plan')
    expect(html).toContain('sam@example.test')
    expect(html).toContain('Archived')
    expect(html).toContain('Not published')
    expect(html).toContain('The site’s owners')
    // Only the live Path opens: the archived and unpublished ones have nothing to serve.
    expect(html.match(/target="_blank"/g)).toHaveLength(1)
    expect(html).toContain(`href="${SITE_URL}PAY-412/"`)
  })

  it('leaves out the owners column for someone who is not on the site', () => {
    const { owners: _o, publishers: _p, ...listed } = sitePath()
    const html = render(createElement(PathsTable, { name: 'plans', paths: [listed] }))
    expect(html).not.toContain('Owners')
  })

  it('explains how to publish one, naming the site', () => {
    expect(publishPathCommand('plans')).toBe('fling deploy ./plan --name plans --path <folder>')
  })
})

describe('the Path page', () => {
  it('offers Restore on every version but the current one, to whoever publishes to it', () => {
    const html = render(
      createElement(PathVersions, {
        name: 'plans',
        served: true,
        path: pathDetail(),
        canRestore: true,
      })
    )
    expect(html).toContain('Current')
    expect(html.match(/>Restore</g)).toHaveLength(1)
    expect(html).toContain('by sam@example.test')
  })

  it('offers no Restore to someone who cannot publish to it, nor while it is archived', () => {
    expect(canRestorePath({ canPublish: false }, 'publisher')).toBe(false)
    expect(canRestorePath({ canPublish: false }, 'admin')).toBe(true)
    const readOnly = render(
      createElement(PathVersions, {
        name: 'plans',
        served: true,
        path: pathDetail(),
        canRestore: false,
      })
    )
    expect(readOnly).not.toContain('>Restore<')
    const archived = render(
      createElement(PathVersions, {
        name: 'plans',
        served: true,
        path: pathDetail({ archived: true }),
        canRestore: true,
      })
    )
    expect(archived).toMatch(/<button[^>]*disabled[^>]*>Restore</)
  })

  it('lets the site’s owners and the Path’s own owners change it, and nobody else', () => {
    const path = sitePath()
    expect(canManagePath(path, 'owner', 'ana@example.test')).toBe(true)
    expect(canManagePath(path, 'admin', 'root@example.test')).toBe(true)
    expect(canManagePath(path, 'publisher', 'sam@example.test')).toBe(true)
    expect(canManagePath(path, 'publisher', 'ana@example.test')).toBe(false)
    expect(canManagePath(path, undefined, undefined)).toBe(false)
  })

  it('shows the owners and publishers, editable or read-only', () => {
    const props = { name: 'plans', path: sitePath(), siteOwner: false }
    const editable = render(createElement(PathTeam, { ...props, editable: true }))
    const readOnly = render(createElement(PathTeam, { ...props, editable: false }))
    for (const html of [editable, readOnly]) {
      expect(html).toContain('Owners and publishers')
      expect(html).toContain('sam@example.test')
    }
    expect(editable).toContain('Add people who look after this Path alone')
    expect(readOnly).not.toContain('Add people who look after this Path alone')
    expect(editable).toContain('Remove sam@example.test')
    expect(readOnly).not.toContain('Remove sam@example.test')
  })

  it('has no roles to show to someone who is not on the site', () => {
    const { owners: _o, ...path } = sitePath()
    const html = render(
      createElement(PathTeam, { name: 'plans', path, editable: false, siteOwner: false })
    )
    expect(html).toBe('')
  })

  it('archives a live Path, and unarchives an archived one', () => {
    const live = render(createElement(PathDangerZone, { name: 'plans', path: sitePath() }))
    expect(live).toContain('Archive…')
    expect(live).toContain('Delete…')
    const archived = render(
      createElement(PathDangerZone, { name: 'plans', path: sitePath({ archived: true }) })
    )
    expect(archived).toContain('Unarchive')
    expect(archived).not.toContain('Archive…')
  })
})
