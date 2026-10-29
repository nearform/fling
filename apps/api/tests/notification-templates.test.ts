/**
 * The comment templates name the page a comment is on only when a member wrote it: a guest's
 * comment is unverified, so its email carries no name, no excerpt and no path (design §9). A share
 * to someone invited from outside carries their sign-in link as its button.
 */
import { describe, expect, it } from 'vitest'
import type { ActorView, DeliveryItem } from '../src/notifications/channel.ts'
import { TEMPLATES } from '../src/notifications/templates/index.ts'

const site = { name: 'q3-report', url: 'https://fling.example.test/review/q3-report' }
const ctx = {
  instance: 'Acme Fling',
  appOrigin: 'https://fling.example.test',
  to: 'alice@example.test',
  site,
  invitation: null,
}
const PATH = '/visit-evil.example.test/'

const BEN: ActorView = { kind: 'user', email: 'ben@example.test', name: 'Ben' }
const GUEST: ActorView = { kind: 'guest' }

function item<K extends 'comment.created' | 'comment.reply'>(
  key: K,
  actor: ActorView
): DeliveryItem<K> {
  return {
    key,
    eventId: `${key}:1`,
    actor,
    details: {
      site,
      comment: {
        id: 'c1',
        threadId: 'c1',
        path: PATH,
        url: `${site.url}?path=${encodeURIComponent(PATH)}&thread=c1`,
        excerpt: actor.kind === 'guest' ? null : 'Looks good',
      },
    },
  } as DeliveryItem<K>
}

describe('comment templates', () => {
  for (const key of ['comment.created', 'comment.reply'] as const) {
    it(`${key}: a member's comment names its page`, () => {
      const section = TEMPLATES[key].email([item(key, BEN)] as never, ctx)
      expect(section.lead).toContain(`on ${PATH}`)
    })

    it(`${key}: a guest's comment names neither its page nor the guest`, () => {
      const section = TEMPLATES[key].email([item(key, GUEST)] as never, ctx)
      expect(section.lead).not.toContain(PATH)
      expect(section.lead).not.toContain('evil')
      expect(section.lead).toMatch(/^A guest /)
      expect(section.quotes ?? []).toEqual([])
    })
  }
})

describe('a share to someone invited from outside', () => {
  const shared = {
    key: 'site.shared',
    eventId: 'e1',
    actor: BEN,
    details: { site },
  } as DeliveryItem<'site.shared'>
  const invitation = { url: 'https://fling.example.test/auth/link?t=x', ttlSeconds: 7 * 86_400 }

  it('says who shared, the instance and "invited as a reviewer"; the button is the link', () => {
    const section = TEMPLATES['site.shared'].email([shared], {
      ...ctx,
      to: 'pat@outside.test',
      invitation: { ...invitation, guest: true },
    })
    expect(section.lead).toBe('Ben (ben@example.test) shared q3-report with you on Acme Fling.')
    expect(section.lines?.[0]).toContain("You've been invited to Acme Fling as a reviewer")
    expect(section.lines?.at(-1)).toContain('signs you in as pat@outside.test')
    expect(section.lines?.at(-1)).toContain('within 7 days')
    expect(section.action).toEqual({ label: 'Sign in and open q3-report', url: invitation.url })
  })

  it('without an invitation, the button opens the review page', () => {
    const section = TEMPLATES['site.shared'].email([shared], ctx)
    expect(section.action.url).toBe(site.url)
    expect(section.lines ?? []).toEqual([])
  })
})
