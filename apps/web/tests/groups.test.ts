import { GROUP_SLUG_MAX, isValidGroupSlug } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { checkNewGroup, slugFromName } from '../src/lib/groups'

describe("a new group's suggested slug", () => {
  it('follows the name: lowercase words joined by single hyphens', () => {
    expect(slugFromName('Design Team!')).toBe('design-team')
    expect(slugFromName('  Crème -- brûlée ')).toBe('creme-brulee')
  })

  it('is always a valid slug, or empty', () => {
    for (const name of ['---', 'A'.repeat(80), 'a '.repeat(40), 'Ops & Infra 2026']) {
      const slug = slugFromName(name)
      expect(slug === '' || isValidGroupSlug(slug)).toBe(true)
      expect(slug.length).toBeLessThanOrEqual(GROUP_SLUG_MAX)
    }
  })
})

describe('checking the new group form', () => {
  it('sends the slug and name trimmed, and the members as addresses', () => {
    expect(
      checkNewGroup({ slug: ' Design ', name: ' Design team ', members: 'A@x.test,\nb@x.test' })
    ).toEqual({ ok: true, slug: 'design', name: 'Design team', members: ['a@x.test', 'b@x.test'] })
  })

  it('asks for a name, a valid slug and real addresses', () => {
    expect(checkNewGroup({ slug: 'design', name: ' ', members: '' }).ok).toBe(false)
    expect(checkNewGroup({ slug: 'two--hyphens', name: 'X', members: '' })).toMatchObject({
      ok: false,
      problem: expect.stringContaining('lowercase letters'),
    })
    expect(checkNewGroup({ slug: 'design', name: 'X', members: 'bob' })).toMatchObject({
      ok: false,
      problem: 'Not an email address: bob',
    })
  })
})
