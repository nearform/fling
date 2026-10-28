import { AUDIENCE_EMAILS_MAX, GROUP_MEMBERS_MAX, type Site } from '@fling/shared'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SiteBadges } from '../src/components/site/badges'
import { audienceLevel, choiceOf } from '../src/components/site/SiteAccess'
import {
  accessBadgeLabel,
  addToAudience,
  addToGroup,
  audienceWho,
  peopleLabel,
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
    expect(audienceWho(2, 1)).toBe('2 people and 1 group')
    expect(audienceWho(0, 3)).toBe('3 groups')
  })
})

describe('the access badge', () => {
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

  it("names the site's access level", () => {
    expect(badges(site({ access: 'only_me', restricted: true }))).toContain('Only you')
    expect(badges(site({ access: 'members' }))).toContain('Everyone signed in')
    expect(badges(site({ access: 'public', visibility: 'public', audienceSize: 2 }))).toContain(
      'Public'
    )
  })

  it('counts the people and teams a list names, the groups apart from the people', () => {
    expect(accessBadgeLabel(site({ access: 'people', restricted: true, audienceSize: 2 }))).toBe(
      'Specific people · 2 people'
    )
    expect(
      accessBadgeLabel(
        site({ access: 'people', restricted: true, audienceSize: 3, audienceGroups: 1 })
      )
    ).toBe('Specific people · 2 people · 1 group')
    expect(
      accessBadgeLabel(
        site({ access: 'groups', restricted: true, audienceSize: 1, audienceGroups: 1 })
      )
    ).toBe('Teams · 1 group')
  })

  it('reads the level from the rest on servers that do not send it', () => {
    expect(accessBadgeLabel(site({}))).toBe('Everyone signed in')
    expect(accessBadgeLabel(site({ restricted: true, audienceSize: 1 }))).toBe(
      'Specific people · 1 person'
    )
  })

  it('an archived site wears Archived instead', () => {
    const html = badges(
      site({ access: 'people', restricted: true, audienceSize: 2, archived: true })
    )
    expect(html).toContain('Archived')
    expect(html).not.toContain('Specific people')
  })
})

describe('the Access options', () => {
  it('fold groups and people into one option, and pick the level from the list', () => {
    expect(choiceOf('groups')).toBe('audience')
    expect(choiceOf('people')).toBe('audience')
    expect(choiceOf('only_me')).toBe('only_me')
    expect(choiceOf('public')).toBe('public')
    expect(audienceLevel({ emails: ['a@x.test'] })).toBe('people')
    expect(audienceLevel({ emails: [] })).toBe('groups')
  })
})
