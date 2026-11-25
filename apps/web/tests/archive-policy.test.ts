import {
  ADMIN_ARCHIVE_POLICY_PATH,
  type ArchivePolicyStatus,
  type Me,
  notificationSettings,
} from '@fling/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_ARCHIVE_POLICY_TAB, adminTabsFor } from '../src/components/AdminTabs'
import { ApiError, api } from '../src/lib/api'
import {
  ARCHIVE_POLICY_ACTOR,
  ARCHIVE_POLICY_VARIABLES,
  archiveDueText,
  auditActorLabel,
  auditTargetLabel,
  countingText,
  dayDate,
  dryRunConfirm,
  goLiveConfirm,
  keepText,
  pausedText,
  policyArchivedText,
  policyState,
  previewAction,
  previewWhen,
  recentLabel,
  settingsText,
  settingVariables,
  showsArchivePolicyAdmin,
  stateText,
  switchError,
  TURN_ON_DEFAULTS,
} from '../src/lib/archive-policy'
import { matrixSections } from '../src/lib/notifications'

const FLING = 'Example Fling'

const status = (over: Partial<ArchivePolicyStatus> = {}): ArchivePolicyStatus => ({
  settings: { inactiveDays: 90, warnDays: 7, deleteArchivedDays: 180, purgeDeletedDays: 30 },
  on: true,
  live: false,
  mail: true,
  siteDelete: 'soft',
  paused: null,
  countingSince: '2026-08-01T00:00:00Z',
  preview: {
    from: '2026-11-25T12:00:00Z',
    to: '2026-12-02T12:00:00Z',
    sites: [],
    purge: [],
    more: false,
  },
  recent: [],
  ...over,
})

const me = (over: Partial<Me> = {}): Me => ({
  email: 'boss@example.test',
  name: 'Boss',
  picture: null,
  userSlug: 'boss',
  admin: true,
  guest: false,
  ...over,
})

describe('Admin → Archive policy', () => {
  it('is among the Admin tabs on every instance, for admins in their own session', () => {
    expect(ADMIN_ARCHIVE_POLICY_TAB).toMatchObject({
      to: ADMIN_ARCHIVE_POLICY_PATH,
      label: 'Archive policy',
    })
    expect(adminTabsFor(false)).toContain(ADMIN_ARCHIVE_POLICY_TAB)
    expect(adminTabsFor(true, true, true)).toContain(ADMIN_ARCHIVE_POLICY_TAB)
    expect(showsArchivePolicyAdmin(me())).toBe(true)
    expect(showsArchivePolicyAdmin(me({ admin: false }))).toBe(false)
    expect(showsArchivePolicyAdmin(me({ impersonator: 'boss@example.test' }))).toBe(false)
  })

  it('names the four variables that turn it on, where it is off', () => {
    expect(ARCHIVE_POLICY_VARIABLES.map(v => v.name)).toEqual([
      'ARCHIVE_INACTIVE_DAYS',
      'ARCHIVE_WARN_DAYS',
      'DELETE_ARCHIVED_DAYS',
      'PURGE_DELETED_DAYS',
    ])
    const warn = ARCHIVE_POLICY_VARIABLES.find(v => v.name === 'ARCHIVE_WARN_DAYS')?.about
    expect(warn).toMatch(/by email and on the site page/)
    expect(TURN_ON_DEFAULTS).toMatch(/ARCHIVE_WARN_DAYS, which is 7/)
    expect(TURN_ON_DEFAULTS).not.toMatch(/^Every day setting is 0/)
  })

  it('is off, in dry run or live', () => {
    expect(policyState(status({ on: false }))).toBe('off')
    expect(policyState(status())).toBe('dry_run')
    expect(policyState(status({ live: true }))).toBe('live')
  })

  it('says what the settings make it do in the CLI’s words, with the variables behind them', () => {
    expect(settingsText(status())).toEqual([
      'Archives a site nobody has viewed or published for 90 days, after telling its owners 7 days before. A kept site is left alone.',
      'Deletes a site it archived 180 days after, warning its owners first; an admin can recover it.',
      "Deletes a deleted site's kept files for good 30 days after it was deleted.",
    ])
    expect(settingVariables(status())).toEqual([
      { name: 'ARCHIVE_INACTIVE_DAYS', value: '90' },
      { name: 'ARCHIVE_WARN_DAYS', value: '7' },
      { name: 'DELETE_ARCHIVED_DAYS', value: '180' },
      { name: 'PURGE_DELETED_DAYS', value: '30' },
      { name: 'SITE_DELETE', value: 'soft' },
    ])
  })

  it('says it never deletes without email, even with DELETE_ARCHIVED_DAYS set', () => {
    expect(settingsText(status({ mail: false }))[1]).toMatch(
      /^Never deletes the sites it archives: this Fling sends no email/
    )
  })

  it('says what dry run, live and off mean', () => {
    expect(stateText(status())).toBe('It works out what it would do, and does and sends nothing.')
    expect(stateText(status({ live: true }))).toMatch(/^It warns owners, archives, deletes/)
    expect(stateText(status({ on: false }))).toMatch(/^Off: /)
  })

  it('says why it is paused, with the date counting has run long enough', () => {
    expect(pausedText({ reason: 'view_counts_off' })).toMatch(
      /^Paused: .*this Fling counts no views \(SITE_VIEW_COUNTS is off\)/
    )
    expect(pausedText({ reason: 'counting_off' })).toMatch(
      /view counting is turned off \(Admin → Usage\)/
    )
    const until = '2026-12-20T00:00:00Z'
    expect(pausedText({ reason: 'counting_too_short', until })).toContain(dayDate(until))
    for (const reason of ['view_counts_off', 'counting_off', 'counting_too_short'] as const) {
      expect(pausedText({ reason })).toContain('Purging goes on.')
    }
    expect(countingText(null)).toBe('Views are not being counted.')
  })

  it('warns before going live that owners are warned first, and how long nothing is archived', () => {
    const text = goLiveConfirm(status(), FLING)
    expect(text).toContain(
      'The owners of the sites due get warned first by email: nothing is archived for at least 7 days.'
    )
    expect(text).toContain('deleted 180 days later')
    expect(text).toContain('older than 30 days are deleted for good')
    expect(text).toContain('This is recorded, with your email.')
  })

  it('says going live without mail warns on the site page only and never deletes', () => {
    const text = goLiveConfirm(status({ mail: false }), FLING)
    expect(text).toContain('on the site page only')
    expect(text).not.toContain('180 days later')
  })

  it('never says owners are told only as their sites are archived (the warning is at least a day)', () => {
    const text = goLiveConfirm(status({ settings: { ...status().settings, warnDays: 1 } }), FLING)
    expect(text).toContain('nothing is archived for at least 1 day.')
    // 0 can't be set while archiving is on: there is no wording for it.
    const zero = goLiveConfirm(status({ settings: { ...status().settings, warnDays: 0 } }), FLING)
    expect(zero).not.toContain('ARCHIVE_WARN_DAYS is 0')
  })

  it('says going back to dry run stops it acting', () => {
    expect(dryRunConfirm).toMatch(/^Nothing more is warned, archived, deleted or purged/)
  })

  it('shows the switch’s refusals in words', () => {
    expect(switchError(new ApiError(400, 'archive_policy_off', 'off'))).toContain(
      'ARCHIVE_INACTIVE_DAYS or PURGE_DELETED_DAYS'
    )
    expect(switchError(new ApiError(403, 'session_required', 'x'))).toContain(
      'needs your browser session'
    )
  })

  it('dates the preview’s rows, what is due already as now', () => {
    const from = '2026-11-25T12:00:00Z'
    expect(previewWhen(from, from)).toBe('Now')
    expect(previewWhen('2026-11-28T12:00:00Z', from)).toBe(dayDate('2026-11-28T12:00:00Z'))
    expect(previewAction('warn_archive')).toBe('Warn its owners it will be archived')
    expect(previewAction('delete')).toBe('Delete')
  })

  it('says what it did lately, a hard delete as for good', () => {
    expect(recentLabel({ action: 'site.archive' })).toBe('Archived')
    expect(recentLabel({ action: 'site.delete', change: 'soft' })).toBe('Deleted')
    expect(recentLabel({ action: 'site.delete', change: 'hard' })).toBe('Deleted for good')
    expect(recentLabel({ action: 'site.purge' })).toBe('Deleted the kept files for good of')
  })
})

describe('the archive policy in Admin → Audit', () => {
  it('names the policy as the actor, and the switch’s state in words', () => {
    expect(auditActorLabel(ARCHIVE_POLICY_ACTOR)).toBe('The archive policy')
    expect(auditActorLabel('boss@example.test')).toBe('boss@example.test')
    expect(auditTargetLabel({ action: 'archive_policy.switch', target: 'dry_run' })).toBe('dry run')
    expect(auditTargetLabel({ action: 'archive_policy.switch', target: 'live' })).toBe('live')
    expect(auditTargetLabel({ action: 'site.archive', target: 'dry_run' })).toBe('dry_run')
  })
})

describe('the site page’s archive policy notices', () => {
  const at = '2026-12-02T09:00:00Z'

  it('says when the policy archives a site, and what stops it, in the CLI’s words', () => {
    expect(archiveDueText({ action: 'archive', at, warned: true })).toBe(
      `Will be archived on ${dayDate(at)}, unless someone views or publishes it first, or an owner keeps it (its owners have been told).`
    )
    expect(archiveDueText({ action: 'archive', at, warned: false })).toMatch(/ at the earliest, /)
  })

  it('says when the policy deletes a site it archived, unless it is unarchived', () => {
    expect(archiveDueText({ action: 'delete', at, warned: true })).toMatch(
      /^Will be deleted on .*, unless it is unarchived first/
    )
    expect(archiveDueText({ action: 'delete', at, warned: false })).toMatch(/at the earliest/)
  })

  it('says a site the policy archived was, and what brings it back; not one an owner archived', () => {
    const text = policyArchivedText({ archived: true, archivedBy: 'policy', archivedAt: at })
    expect(text).toBe(
      `Archived by the archive policy on ${dayDate(at)}: unarchiving or publishing it brings it back.`
    )
    expect(policyArchivedText({ archived: true, archivedAt: at })).toBeNull()
    expect(policyArchivedText({ archived: false, archivedBy: 'policy' })).toBeNull()
  })

  it('says what keeping a site does', () => {
    expect(keepText(true)).toMatch(/^Kept: the archive policy never/)
    expect(keepText(false)).toMatch(/Keep this one to exempt it/)
  })
})

describe('the archive policy’s calls', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps a site with a PUT, and turns the policy live with one', async () => {
    const site = {
      name: 'pitch deck',
      url: 'https://pitch-deck.sites.example.test',
      currentVersionId: null,
      shareUrl: null,
      visibility: 'private',
      archived: false,
      spa: false,
      keep: true,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
    }
    const fetchMock = vi.fn(async (url: string) =>
      Response.json(url.endsWith('/keep') ? site : status({ live: true }))
    )
    vi.stubGlobal('fetch', fetchMock)
    expect((await api.setKeep('pitch deck', true)).keep).toBe(true)
    await api.setArchivePolicyLive(true)
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
      ['/api/sites/pitch%20deck/keep', 'PUT', JSON.stringify({ keep: true })],
      ['/api/admin/archive-policy', 'PUT', JSON.stringify({ live: true })],
    ])
  })
})

describe('the archive policy’s notifications', () => {
  it('lists “Your sites” in the notification settings where the instance has the policy', () => {
    const on = notificationSettings(null, {
      channels: ['email'],
      capabilities: { archivePolicy: true },
    })
    const sites = matrixSections(on).find(s => s.section === 'sites')
    expect(sites?.title).toBe('Your sites')
    expect(sites?.events.map(e => e.key)).toEqual(['site.archive_due', 'site.delete_due'])
    const off = notificationSettings(null, { channels: ['email'], capabilities: {} })
    expect(matrixSections(off).some(s => s.section === 'sites')).toBe(false)
  })
})
