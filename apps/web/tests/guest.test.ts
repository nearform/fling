/**
 * What a guest (someone invited from outside, reviewing only what is shared with them) sees, and
 * how the people lists treat outsiders: the side nav, the site list's tab, the guest badge, the
 * address field's note while outside invitations are on, and a refusal past the day's invitations.
 */
import type { Me } from '@fling/shared'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EmailBadge } from '../src/components/EmailBadge'
import { NAV_ITEMS, navItemsFor } from '../src/components/SideNav'
import { ApiError } from '../src/lib/api'
import { GUEST_TITLE, outsideInviteNote, peopleErrorMessage } from '../src/lib/audience'
import { sitesViewOf } from '../src/lib/sites'

const me = (over: Partial<Me> = {}): Me => ({
  email: 'pat@outside.test',
  name: 'Pat',
  picture: null,
  userSlug: 'pat',
  admin: false,
  guest: false,
  ...over,
})

describe('a guest in the app', () => {
  it('gets Sites alone in the side nav: no Groups, Connections or Get started', () => {
    const items = navItemsFor(me({ guest: true }), { capabilities: { groups: true } })
    expect(items).toEqual([NAV_ITEMS[0]])
    expect(items.map(i => i.label)).toEqual(['Sites'])
  })

  it('sees Shared with me whatever the address asks for', () => {
    const guest = { guest: true, sharing: true, admin: false }
    for (const param of [null, 'active', 'archived', 'all', 'shared']) {
      expect(sitesViewOf(param, guest)).toBe('shared')
    }
  })

  it('members keep their tabs: active by default, the others when they have them', () => {
    const member = { guest: false, sharing: true, admin: false }
    expect(sitesViewOf(null, member)).toBe('active')
    expect(sitesViewOf('archived', member)).toBe('archived')
    expect(sitesViewOf('shared', member)).toBe('shared')
    expect(sitesViewOf('shared', { ...member, sharing: false })).toBe('active')
    expect(sitesViewOf('all', member)).toBe('active')
    expect(sitesViewOf('all', { ...member, admin: true })).toBe('all')
  })
})

describe('the guest badge', () => {
  it('marks a guest where people are listed, explained on hover', () => {
    const html = renderToStaticMarkup(
      createElement(EmailBadge, { email: 'pat@outside.test', guest: true })
    )
    expect(html).toContain('Guest')
    expect(html).toContain(`title="${GUEST_TITLE}"`)
  })

  it('marks nobody else', () => {
    const html = renderToStaticMarkup(createElement(EmailBadge, { email: 'bob@example.test' }))
    expect(html).not.toContain('Guest')
  })
})

describe('adding people from outside', () => {
  const instance = (invites: boolean) => ({ name: 'Acme Fling', capabilities: { invites } })

  it('says outside addresses are invited as reviewers, while invitations are on', () => {
    expect(outsideInviteNote(instance(true))).toMatch(
      /^Someone from outside Acme Fling is invited as a reviewer/
    )
    expect(outsideInviteNote(instance(false))).toBeNull()
    expect(outsideInviteNote({ name: 'Acme Fling', capabilities: {} })).toBeNull()
    expect(outsideInviteNote(null)).toBeNull()
  })

  it("past the day's invitations, says nobody was added, then why", () => {
    const error = new ApiError(
      429,
      'too_many_invites',
      'You can invite 20 people from outside Acme Fling a day. Try again tomorrow, or ask an admin to invite them'
    )
    expect(peopleErrorMessage(error)).toBe(
      'Nobody was added. You can invite 20 people from outside Acme Fling a day. Try again tomorrow, or ask an admin to invite them.'
    )
  })

  it('passes any other refusal through', () => {
    const error = new ApiError(400, 'email_not_allowed', 'Not an address that can sign in')
    expect(peopleErrorMessage(error)).toBe('Not an address that can sign in')
  })
})
