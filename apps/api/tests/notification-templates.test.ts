/**
 * The comment templates name the page a comment is on only when a member wrote it: a guest's
 * comment is unverified, so its email carries no name, no excerpt and no path (design §9).
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
