import { describe, expect, it } from 'vitest'
import { countLabel, filterSites, matchesQuery, queryTerms } from '../src/lib/search'

const site = (name: string, shareUrl: string | null = null) => ({
  name,
  url: `https://${name}.sites.example.test/`,
  shareUrl,
})

const sites = [
  site('marketing-landing'),
  site('q3-report', 'https://s--abc123.sites.example.test/'),
  site('design-system-docs'),
]

describe('site search', () => {
  it('splits the query into lower-cased words', () => {
    expect(queryTerms('  Q3   Report ')).toEqual(['q3', 'report'])
    expect(queryTerms('   ')).toEqual([])
  })

  it('returns every site for a blank query', () => {
    expect(filterSites(sites, '')).toEqual(sites)
    expect(filterSites(sites, '  ')).toEqual(sites)
  })

  it('matches the name case-insensitively, as a substring', () => {
    expect(filterSites(sites, 'LAND').map(s => s.name)).toEqual(['marketing-landing'])
  })

  it('matches the URL and the share URL', () => {
    expect(matchesQuery(sites[0], 'sites.example')).toBe(true)
    expect(filterSites(sites, 's--abc').map(s => s.name)).toEqual(['q3-report'])
  })

  it('needs every word to match, in any field and order', () => {
    expect(filterSites(sites, 'docs design').map(s => s.name)).toEqual(['design-system-docs'])
    expect(filterSites(sites, 'report abc123').map(s => s.name)).toEqual(['q3-report'])
    expect(filterSites(sites, 'docs report')).toEqual([])
  })

  it('keeps the original order and does not mutate the input', () => {
    const copy = [...sites]
    expect(filterSites(sites, 'example').map(s => s.name)).toEqual(copy.map(s => s.name))
    expect(sites).toEqual(copy)
  })
})

describe('count label', () => {
  const label = (total: number | undefined, shown: number, archived = false, searching = false) =>
    countLabel({ total, shown, archived, searching })

  it('says how many sites are live or archived', () => {
    expect(label(undefined, 0)).toBe('Everything you have flung, in one list')
    expect(label(0, 0)).toBe('Nothing flung yet')
    expect(label(1, 1)).toBe('1 live site')
    expect(label(12, 12)).toBe('12 live sites')
    expect(label(4, 4, true)).toBe('4 archived sites')
  })

  it('says how many match while searching', () => {
    expect(label(12, 3, false, true)).toBe('3 of 12 sites')
    expect(label(1, 0, false, true)).toBe('0 of 1 site')
    expect(label(4, 1, true, true)).toBe('1 of 4 archived sites')
  })
})
