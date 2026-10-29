import { type AdminSettings, type AdminUser, type Me, REPO_URL } from '@fling/shared'
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
  invitationStatus,
  SETTING_GROUP_INFO,
  settingGroups,
  settingText,
  showsAdmin,
  showsInvitationsAdmin,
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
  guest: false,
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

describe('the Settings tab', () => {
  const data: AdminSettings = {
    settings: [
      { key: 'INVITES', group: 'features', value: false, set: false },
      { key: 'INSTANCE_NAME', group: 'branding', value: 'Acme', set: true },
    ],
    secrets: [{ name: 'SESSION_SECRET', group: 'platform', set: true }],
  }

  it('groups settings and secrets in the groups’ order and leaves empty groups out', () => {
    const groups = settingGroups(data)
    expect(groups.map(g => g.group)).toEqual(['branding', 'features', 'platform'])
    expect(groups.find(g => g.group === 'platform')?.secrets).toEqual(data.secrets)
  })

  it('links every group to both deploy guides, never to an instance', () => {
    for (const info of Object.values(SETTING_GROUP_INFO)) {
      expect(info.aws.startsWith(`${REPO_URL}/`)).toBe(true)
      expect(info.cloudflare.startsWith(`${REPO_URL}/`)).toBe(true)
    }
  })

  it('shows values as text, nothing as not set', () => {
    expect(settingText(true)).toBe('on')
    expect(settingText(['a.test', 'b.test'])).toBe('a.test, b.test')
    expect(settingText([])).toBeNull()
    expect(settingText(null)).toBeNull()
    expect(settingText(20)).toBe('20')
  })
})

describe('Admin → Invitations', () => {
  const instance = (invites: boolean) => ({ capabilities: { invites } })

  it('shows to admins in their own session, with outside invitations on', () => {
    expect(showsInvitationsAdmin(me({ admin: true }), instance(true))).toBe(true)
    expect(showsInvitationsAdmin(me({ admin: true }), instance(false))).toBe(false)
    expect(showsInvitationsAdmin(me(), instance(true))).toBe(false)
    expect(showsInvitationsAdmin({ ...impersonating, admin: true }, instance(true))).toBe(false)
  })

  it('says whether each invited person has signed in, or was revoked', () => {
    expect(invitationStatus({ revokedAt: null, signedIn: false })).toBe('Not signed in yet')
    expect(invitationStatus({ revokedAt: null, signedIn: true })).toBe('Signed in')
    expect(invitationStatus({ revokedAt: '2026-01-01T00:00:00Z', signedIn: true })).toBe('Revoked')
  })
})
