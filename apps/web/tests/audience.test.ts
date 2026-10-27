import { AUDIENCE_EMAILS_MAX, type Site } from '@fling/shared'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SiteBadges } from '../src/components/site/badges'
import { addToAudience, peopleLabel, restrictedLabel } from '../src/lib/audience'

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

  it('counts people in words', () => {
    expect(peopleLabel(1)).toBe('1 person')
    expect(peopleLabel(3)).toBe('3 people')
    expect(restrictedLabel(1)).toBe('Restricted · 1 person')
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  })
  const badges = (s: Site) => renderToStaticMarkup(createElement(SiteBadges, { site: s }))

  it('says how many people a restricted site is limited to', () => {
    expect(badges(site({ restricted: true, audienceSize: 2 }))).toContain('Restricted · 2 people')
  })

  it('is not worn by a site open to everyone signed in, a public site keeping its list, or an archived one', () => {
    expect(badges(site({}))).not.toContain('Restricted')
    expect(badges(site({ visibility: 'public', audienceSize: 2 }))).not.toContain('Restricted')
    expect(badges(site({ restricted: true, audienceSize: 2, archived: true }))).not.toContain(
      'Restricted'
    )
  })
})
