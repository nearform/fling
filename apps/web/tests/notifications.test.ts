import { type Me, notificationSettings } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { ADMIN_MAIL_TAB, ADMIN_USERS_TAB, adminTabsFor } from '../src/components/AdminTabs'
import { ADMIN_NAV_ITEM, isPathActive } from '../src/components/SideNav'
import {
  ADMIN_MAIL_PATH,
  cellState,
  cellUpdate,
  channelLabel,
  eventTitles,
  hourDate,
  matrixSections,
  showsMailAdmin,
  showsNotifications,
} from '../src/lib/notifications'

const me = (over: Partial<Me> = {}): Me => ({
  email: 'boss@example.test',
  name: 'Boss',
  picture: null,
  userSlug: 'boss',
  admin: false,
  ...over,
})

const caps = (capabilities: Record<string, boolean>) => ({ capabilities })

/** Settings as the server sends them, from the catalogue. */
const settings = (prefs: Parameters<typeof notificationSettings>[0] = null, comments = true) =>
  notificationSettings(prefs, { channels: ['email'], capabilities: { comments } })

describe('where notifications show', () => {
  it('offers the settings page only with the notifications capability', () => {
    expect(showsNotifications(caps({ notifications: true }))).toBe(true)
    expect(showsNotifications(caps({ notifications: false }))).toBe(false)
    expect(showsNotifications(caps({}))).toBe(false)
    expect(showsNotifications(null)).toBe(false)
  })

  it('offers Admin → Mail to admins in their own session, on an instance with email', () => {
    const boss = me({ admin: true })
    expect(showsMailAdmin(boss, caps({ email: true }))).toBe(true)
    expect(showsMailAdmin(boss, caps({ email: false }))).toBe(false)
    expect(showsMailAdmin(boss, caps({ notifications: true }))).toBe(false)
    expect(showsMailAdmin(me(), caps({ email: true }))).toBe(false)
    expect(
      showsMailAdmin(
        me({ admin: true, impersonator: 'boss@example.test', email: 'member@example.test' }),
        caps({ email: true })
      )
    ).toBe(false)
  })

  it('shows the Admin tabs only when there is more than Users', () => {
    expect(adminTabsFor(true)).toEqual([ADMIN_USERS_TAB, ADMIN_MAIL_TAB])
    expect(ADMIN_MAIL_TAB).toMatchObject({ to: ADMIN_MAIL_PATH, label: 'Mail' })
    expect(adminTabsFor(false)).toEqual([ADMIN_USERS_TAB])
  })

  it('keeps Admin active in the side nav on every admin page', () => {
    const match = ADMIN_NAV_ITEM.match ?? ADMIN_NAV_ITEM.to
    expect(isPathActive(ADMIN_MAIL_PATH, match)).toBe(true)
    expect(isPathActive('/admin/users', match)).toBe(true)
    expect(isPathActive('/administer', match)).toBe(false)
  })
})

describe('the matrix', () => {
  it('groups the events by section, in the order the server sends them', () => {
    const s = settings()
    const sections = matrixSections(s)
    expect(sections.flatMap(x => x.events)).toEqual(s.events)
    expect(new Set(sections.map(x => x.section)).size).toBe(sections.length)
    for (const section of sections) expect(section.title).not.toBe('')
  })

  it('leaves out events the instance lacks (comments off)', () => {
    const keys = matrixSections(settings(null, false)).flatMap(x => x.events.map(e => e.key))
    expect(keys.some(k => k.startsWith('comment.'))).toBe(false)
  })

  it('shows a section the client does not know by its key', () => {
    const s = settings()
    const odd = { ...s, events: [{ ...(s.events[0] as (typeof s.events)[number]), section: 'x' }] }
    expect(matrixSections(odd)[0]?.title).toBe('x')
  })

  it('marks the cells you chose, and knows each default', () => {
    const s = settings()
    const event = s.events[0]?.key as string
    const defaultOn = s.events[0]?.defaults.email === 'on'
    expect(cellState(s, event, 'email')).toEqual({ on: defaultOn, own: false, defaultOn })
    const chosen = settings({
      muted: false,
      cells: { [event]: { email: defaultOn ? 'off' : 'on' } },
    })
    expect(cellState(chosen, event, 'email')).toEqual({ on: !defaultOn, own: true, defaultOn })
  })

  it('switching back to the default clears the choice instead of storing it', () => {
    expect(cellUpdate({ defaultOn: true }, 'site.shared', 'email', false)).toEqual({
      cells: { 'site.shared': { email: 'off' } },
    })
    expect(cellUpdate({ defaultOn: true }, 'site.shared', 'email', true)).toEqual({
      cells: { 'site.shared': { email: null } },
    })
    expect(cellUpdate({ defaultOn: false }, 'site.shared', 'email', true)).toEqual({
      cells: { 'site.shared': { email: 'on' } },
    })
  })

  it('names channels, events and hours for people', () => {
    expect(channelLabel('email')).toBe('Email')
    const s = settings()
    const first = s.events[0]
    expect(eventTitles(s)([first?.key as string, 'unknown.event'])).toEqual([
      first?.title,
      'unknown.event',
    ])
    expect(eventTitles(undefined)(['site.shared'])).toEqual(['site.shared'])
    expect(hourDate('2026-10-28T14').toISOString()).toBe('2026-10-28T14:00:00.000Z')
  })
})
