import { describe, expect, it } from 'vitest'
import { chooseSiteSort, parseSiteSort, siteHref } from '../src/lib/sites'

describe('site page and list order', () => {
  it("links to a site's page by name", () => {
    expect(siteHref('q3-report')).toBe('/sites/q3-report')
  })

  it('takes the order from the URL, then the remembered choice, then the default', () => {
    expect(chooseSiteSort('name', 'created')).toBe('name')
    expect(chooseSiteSort(null, 'created')).toBe('created')
    expect(chooseSiteSort('size', 'created')).toBe('created')
    expect(chooseSiteSort(null, null)).toBe('updated')
    expect(chooseSiteSort(null, 'nonsense')).toBe('updated')
    expect(parseSiteSort(undefined)).toBe('updated')
  })
})
