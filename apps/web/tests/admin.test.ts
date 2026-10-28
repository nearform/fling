import type { AdminUser, Me } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_NAV_ITEM,
  GET_STARTED_NAV_ITEM,
  GROUPS_NAV_ITEM,
  NAV_ITEMS,
  navItemsFor,
} from '../src/components/SideNav'
import {
  ADMIN_USERS_PATH,
  impersonateBlocked,
  impersonationNotice,
  showsAdmin,
} from '../src/lib/admin'

const me = (over: Partial<Me> = {}): Me => ({
  email: 'boss@example.test',
  name: 'Boss',
  picture: null,
  userSlug: 'boss',
  admin: false,
  ...over,
})

const user = (over: Partial<AdminUser> = {}): AdminUser => ({
  email: 'member@example.test',
  name: 'Member',
  picture: null,
  userSlug: 'member',
  createdAt: null,
  lastSignInAt: null,
  siteCount: 0,
  admin: false,
  ...over,
})

const impersonating = me({
  email: 'member@example.test',
  impersonator: 'boss@example.test',
  impersonationEndsAt: '2026-01-01T01:00:00.000Z',
})

describe('the side nav', () => {
  it('offers Admin → Users to admins only', () => {
    expect(navItemsFor(me({ admin: true }))).toEqual([
      ...NAV_ITEMS,
      ADMIN_NAV_ITEM,
      GET_STARTED_NAV_ITEM,
    ])
    expect(ADMIN_NAV_ITEM).toMatchObject({ to: ADMIN_USERS_PATH, label: 'Admin' })
    expect(navItemsFor(me())).toEqual([...NAV_ITEMS, GET_STARTED_NAV_ITEM])
    expect(navItemsFor(null)).toEqual([...NAV_ITEMS, GET_STARTED_NAV_ITEM])
    expect(navItemsFor(undefined)).toEqual([...NAV_ITEMS, GET_STARTED_NAV_ITEM])
  })

  it('puts Get started last', () => {
    expect(navItemsFor(me({ admin: true }), { capabilities: { groups: true } }).at(-1)).toBe(
      GET_STARTED_NAV_ITEM
    )
  })

  it('offers Groups, after Sites, only where the instance has the groups capability', () => {
    const labels = (caps: Record<string, boolean>) =>
      navItemsFor(me(), { capabilities: caps }).map(i => i.label)
    expect(labels({ groups: true }).slice(0, 2)).toEqual(['Sites', GROUPS_NAV_ITEM.label])
    expect(labels({})).not.toContain(GROUPS_NAV_ITEM.label)
    expect(labels({ groups: false })).not.toContain(GROUPS_NAV_ITEM.label)
    expect(navItemsFor(me())).not.toContain(GROUPS_NAV_ITEM)
  })

  it('not while impersonating, even if the server said admin', () => {
    expect(showsAdmin(impersonating)).toBe(false)
    expect(navItemsFor({ ...impersonating, admin: true })).toEqual([
      ...NAV_ITEMS,
      GET_STARTED_NAV_ITEM,
    ])
  })
})

describe('the impersonation banner', () => {
  it('says whom the admin is viewing as, only while impersonating', () => {
    expect(impersonationNotice(impersonating)).toBe('Viewing as member@example.test')
    expect(impersonationNotice(me({ admin: true }))).toBeNull()
    expect(impersonationNotice(null)).toBeNull()
  })
})

describe('the users list', () => {
  it('has no Impersonate for yourself or another admin', () => {
    const boss = me({ admin: true })
    expect(impersonateBlocked(boss, user())).toBeNull()
    expect(impersonateBlocked(boss, user({ email: boss.email, admin: true }))).toBe('You')
    expect(impersonateBlocked(boss, user({ email: 'other@example.test', admin: true }))).toBe(
      'Admin'
    )
  })
})
