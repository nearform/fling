import { AUDIENCE_EMAILS_MAX, GROUP_MEMBERS_MAX, type Site } from '@fling/shared'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SiteBadges } from '../src/components/site/badges'
import {
  addToAudience,
  addToGroup,
  audienceWho,
  opensToEveryone,
  peopleLabel,
  restrictedLabel,
} from '../src/lib/audience'

describe('adding people to an audience', () => {
  it('takes several addresses at once, lowercased, trimmed and each once, after the current ones', () => {
    expect(
      addToAudience(['a@example.test'], ' B@Example.test, c@example.test;a@example.test ')
    ).toEqual({
      emails: ['a@example.test', 'b@example.test', 'c@example.test'],
      invalid: [],
      overflow: [],
    })
  })

  it('leaves what is not an address out, to be fixed in the input', () => {
    expect(addToAudience([], 'bob@example.test bob')).toEqual({
      emails: ['bob@example.test'],
      invalid: ['bob'],
      overflow: [],
    })
  })

  it(`stops at ${AUDIENCE_EMAILS_MAX} people`, () => {
    const full = Array.from({ length: AUDIENCE_EMAILS_MAX - 1 }, (_, i) => `u${i}@example.test`)
    const result = addToAudience(full, 'last@example.test, extra@example.test')
    expect(result.emails).toHaveLength(AUDIENCE_EMAILS_MAX)
    expect(result.emails.at(-1)).toBe('last@example.test')
    expect(result.overflow).toEqual(['extra@example.test'])
  })

  it(`fills a group up to ${GROUP_MEMBERS_MAX} people`, () => {
    const full = Array.from({ length: GROUP_MEMBERS_MAX - 1 }, (_, i) => `u${i}@example.test`)
    const result = addToGroup(full, 'last@example.test, extra@example.test')
    expect(result.emails).toHaveLength(GROUP_MEMBERS_MAX)
    expect(result.overflow).toEqual(['extra@example.test'])
  })

  it('counts people and groups in words, leaving out what is zero', () => {
    expect(peopleLabel(1)).toBe('1 person')
    expect(peopleLabel(3)).toBe('3 people')
    expect(restrictedLabel(1)).toBe('Restricted · 1 person')
    expect(restrictedLabel(2, 1)).toBe('Restricted · 2 people · 1 group')
    expect(restrictedLabel(0, 2)).toBe('Restricted · 2 groups')
    expect(audienceWho(2, 1)).toBe('2 people and 1 group')
    expect(audienceWho(0, 3)).toBe('3 groups')
  })
})

describe('the restricted badge', () => {
  const site = (overrides: Partial<Site>): Site => ({
    name: 'team',
    url: 'https://team.sites.example.test/',
    visibility: 'private',
    spa: false,
    archived: false,
    currentVersionId: 'v1',
    shareUrl: null,
    restricted: false,
    audienceSize: 0,
    audienceGroups: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  })
  const badges = (s: Site) => renderToStaticMarkup(createElement(SiteBadges, { site: s }))

  it('says how many people a restricted site is limited to', () => {
    expect(badges(site({ restricted: true, audienceSize: 2 }))).toContain('Restricted · 2 people')
  })

  it('counts the groups apart from the people', () => {
    const html = badges(site({ restricted: true, audienceSize: 3, audienceGroups: 1 }))
    expect(html).toContain('Restricted · 2 people · 1 group')
    expect(badges(site({ restricted: true, audienceSize: 1, audienceGroups: 1 }))).toContain(
      'Restricted · 1 group'
    )
  })

  it('is not worn by a site open to everyone signed in, a public site keeping its list, or an archived one', () => {
    expect(badges(site({}))).not.toContain('Restricted')
    expect(badges(site({ visibility: 'public', audienceSize: 2 }))).not.toContain('Restricted')
    expect(badges(site({ restricted: true, audienceSize: 2, archived: true }))).not.toContain(
      'Restricted'
    )
  })
})

describe('opensToEveryone', () => {
  const list = (emails: string[], groups: string[] = []) => ({ emails, groups })

  it('is true only when an edit empties an audience that named someone', () => {
    expect(opensToEveryone(list(['a@x.test']), list([]))).toBe(true)
    expect(opensToEveryone(list([], ['design']), list([]))).toBe(true)
    expect(opensToEveryone(list([], ['#deleted']), list([]))).toBe(true)
    expect(opensToEveryone(list(['a@x.test'], ['design']), list([], ['design']))).toBe(false)
    expect(opensToEveryone(list([]), list([]))).toBe(false)
    expect(opensToEveryone(list([]), list(['a@x.test']))).toBe(false)
  })
})
