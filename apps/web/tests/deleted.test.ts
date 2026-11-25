import { ADMIN_DELETED_PATH, deleteConfirmText, type RestoreResult } from '@fling/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_DELETED_TAB, adminTabsFor } from '../src/components/AdminTabs'
import { api } from '../src/lib/api'
import {
  deletedLabel,
  deletedUsageText,
  purgeConfirmOf,
  purgedText,
  restoredHeadline,
  restoreNameOf,
  restoreNotes,
} from '../src/lib/deleted'

const result = (over: Partial<RestoreResult> = {}): RestoreResult => ({
  name: 'pitch-deck',
  url: 'https://pitch-deck.sites.example.test',
  dropped: { emails: [], groups: [] },
  adminBecameOwner: false,
  ...over,
})

describe('Admin → Deleted', () => {
  it('is among the Admin tabs on every instance', () => {
    expect(ADMIN_DELETED_TAB).toMatchObject({ to: ADMIN_DELETED_PATH, label: 'Deleted' })
    expect(adminTabsFor(false)).toContain(ADMIN_DELETED_TAB)
    expect(adminTabsFor(true, true, true)).toContain(ADMIN_DELETED_TAB)
  })

  it('names a site by its name and a Path by its folder on its site', () => {
    expect(deletedLabel({ kind: 'site', name: 'pitch-deck' })).toBe('pitch-deck')
    expect(deletedLabel({ kind: 'path', name: 'pitch-deck', folder: 'docs' })).toBe(
      '/docs/ of pitch-deck'
    )
  })

  it('sends a name with a restore only when it is not the site’s own', () => {
    expect(restoreNameOf('pitch-deck', 'pitch-deck')).toBeUndefined()
    expect(restoreNameOf('pitch-deck', '  ')).toBeUndefined()
    expect(restoreNameOf('pitch-deck', ' pitch-deck-2 ')).toBe('pitch-deck-2')
  })

  it('says what a site’s restore brought back and what it left out', () => {
    const notes = restoreNotes(
      result({
        paths: ['docs'],
        adminBecameOwner: true,
        dropped: { emails: ['gone@example.test'], groups: ['old-team'] },
        server: { state: 'needs_secrets', secrets: ['API_KEY', 'DB_URL'] },
      })
    )
    expect(restoredHeadline(result())).toBe('Restored pitch-deck')
    expect(notes).toEqual([
      'Its Paths are back too: /docs/.',
      'No owner was left, so you are its owner now.',
      'Left out, as they are no longer on this Fling: gone@example.test.',
      'Left out, as these groups no longer exist: old-team.',
      expect.stringContaining('until its secrets are set: API_KEY, DB_URL. Its owner sets them'),
      'Its share link is not restored: the owner can share it again.',
    ])
  })

  it('says a Path’s restore without the share link note', () => {
    const r = result({ folder: 'docs', server: { state: 'running' } })
    expect(restoredHeadline(r)).toBe('Restored /docs/ of pitch-deck')
    expect(restoreNotes(r)).toEqual(['Its site server is running again.'])
  })
})

describe('deleting for good on Admin → Deleted', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks before deleting a site or a Path for good, saying it can’t be restored', () => {
    expect(purgeConfirmOf({ kind: 'site', name: 'pitch-deck' })).toBe(
      "Delete pitch-deck for good? Its files are removed from storage and it can't be restored."
    )
    expect(purgeConfirmOf({ kind: 'path', name: 'pitch-deck', folder: 'docs' })).toMatch(
      /^Delete docs\/ of pitch-deck for good\?/
    )
    expect(purgedText({ kind: 'path', name: 'pitch-deck', folder: 'docs' })).toBe(
      'Deleted /docs/ of pitch-deck for good.'
    )
  })

  it('deletes a site at its id and a Path at its own', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await api.purgeSite('s 1')
    await api.purgePath('s1', 'p1')
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ['/api/admin/deleted/s%201', 'DELETE'],
      ['/api/admin/deleted/s1/paths/p1', 'DELETE'],
    ])
  })
})

describe('the delete wording', () => {
  it('says whether an admin can recover it', () => {
    expect(deleteConfirmText(true, 'pitch-deck')).toContain('An admin can recover it.')
    expect(deleteConfirmText(false, 'pitch-deck')).toContain("This can't be undone.")
  })
})

describe('Admin → Usage’s deleted sites', () => {
  it('counts the kept sites, the Paths when there are any, and about how much', () => {
    expect(deletedUsageText({ sites: 42, paths: 0, bytes: 3.1 * 1024 ** 3 })).toBe(
      'Deleted sites: 42, about 3.1 GB kept.'
    )
    expect(deletedUsageText({ sites: 2, paths: 3, bytes: 2048 })).toBe(
      'Deleted sites: 2, Paths: 3, about 2.0 KB kept.'
    )
    expect(deletedUsageText({ sites: 0, paths: 0, bytes: 0 })).toBe('Deleted sites: none kept.')
  })
})
