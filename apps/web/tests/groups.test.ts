import { AUDIENCE_GROUPS_MAX, GROUP_SLUG_MAX, isValidGroupSlug } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import {
  checkNewGroup,
  sameMembers,
  slugFromName,
  splitEmail,
  swapEmailsForGroup,
} from '../src/lib/groups'

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

describe('an email badge splits an address', () => {
  it('into the name and the @domain, at the last @', () => {
    expect(splitEmail('ann.lee@example.test')).toEqual({
      local: 'ann.lee',
      domain: '@example.test',
    })
    expect(splitEmail('"a@b"@example.test')).toEqual({ local: '"a@b"', domain: '@example.test' })
  })

  it('keeps something without a domain whole', () => {
    expect(splitEmail('ann')).toEqual({ local: 'ann', domain: '' })
    expect(splitEmail('@example.test')).toEqual({ local: '@example.test', domain: '' })
  })
})

describe('the same people', () => {
  it('in any order or case, each once', () => {
    expect(sameMembers(['a@x.test', 'B@x.test'], ['b@x.test', 'a@x.test', 'a@x.test'])).toBe(true)
  })

  it('not when either list has someone the other lacks', () => {
    expect(sameMembers(['a@x.test'], ['a@x.test', 'b@x.test'])).toBe(false)
    expect(sameMembers(['a@x.test', 'c@x.test'], ['a@x.test', 'b@x.test'])).toBe(false)
    expect(sameMembers([], ['a@x.test'])).toBe(false)
  })
})

describe('swapping listed people for a group', () => {
  const audience = { emails: ['a@x.test', 'b@x.test', 'c@x.test'], groups: ['ops'] }

  it('takes out the addresses the group holds and names the group once', () => {
    expect(
      swapEmailsForGroup(audience, { slug: 'design', members: ['A@x.test', 'b@x.test'] })
    ).toEqual({ emails: ['c@x.test'], groups: ['ops', 'design'] })
    expect(swapEmailsForGroup(audience, { slug: 'ops', members: ['c@x.test'] })).toEqual({
      emails: ['a@x.test', 'b@x.test'],
      groups: ['ops'],
    })
  })

  it('never takes out an address the group does not hold', () => {
    const next = swapEmailsForGroup(audience, { slug: 'design', members: ['z@x.test'] })
    expect(next?.emails).toEqual(audience.emails)
  })

  it('declines when the audience names as many groups as it may', () => {
    const groups = Array.from({ length: AUDIENCE_GROUPS_MAX }, (_, i) => `g${i}`)
    expect(
      swapEmailsForGroup({ emails: ['a@x.test'], groups }, { slug: 'new', members: ['a@x.test'] })
    ).toBeNull()
    expect(
      swapEmailsForGroup({ emails: ['a@x.test'], groups }, { slug: 'g0', members: ['a@x.test'] })
    ).toEqual({ emails: [], groups })
  })
})
