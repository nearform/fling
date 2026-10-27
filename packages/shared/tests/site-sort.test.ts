import { describe, expect, it } from 'vitest'
import { DEFAULT_SITE_SORT, isSiteSort, SITE_SORTS, sortSites } from '../src/site-sort.ts'

const site = (name: string, createdAt: string, updatedAt: string) => ({
  name,
  createdAt: `2026-01-${createdAt}T00:00:00.000Z`,
  updatedAt: `2026-02-${updatedAt}T00:00:00.000Z`,
})

const sites = [
  site('bravo', '01', '03'),
  site('alpha', '03', '01'),
  site('charlie', '02', '03'),
  site('delta', '02', '02'),
]
const names = (list: { name: string }[]) => list.map(s => s.name)

describe('sortSites', () => {
  it('defaults to last updated, newest first, ties by name', () => {
    expect(DEFAULT_SITE_SORT).toBe('updated')
    expect(names(sortSites(sites))).toEqual(['bravo', 'charlie', 'delta', 'alpha'])
    expect(names(sortSites(sites, 'updated'))).toEqual(names(sortSites(sites)))
  })

  it('sorts by created, newest first, ties by name', () => {
    expect(names(sortSites(sites, 'created'))).toEqual(['alpha', 'charlie', 'delta', 'bravo'])
  })

  it('sorts by name, A–Z', () => {
    expect(names(sortSites(sites, 'name'))).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
  })

  it('returns a new array and leaves the input alone', () => {
    const before = names(sites)
    const sorted = sortSites(sites, 'name')
    expect(sorted).not.toBe(sites)
    expect(names(sites)).toEqual(before)
  })

  it('accepts only the known sorts', () => {
    for (const sort of SITE_SORTS) expect(isSiteSort(sort)).toBe(true)
    expect(isSiteSort('size')).toBe(false)
    expect(isSiteSort(undefined)).toBe(false)
  })
})
