import { describe, expect, it } from 'vitest'
import { describeSharedSite, sharedVia } from '../src/audience.ts'

const site = (direct: boolean, groups: string[]) => ({
  name: 'plan',
  url: 'https://plan.sites.example.test/',
  owner: 'ann@example.test',
  via: { direct, groups },
})

describe('sites shared with someone', () => {
  it('say how the site reached them', () => {
    expect(sharedVia(site(true, []))).toBe('your address')
    expect(sharedVia(site(false, ['design']))).toBe('group design')
    expect(sharedVia(site(true, ['design', 'ops']))).toBe('your address and groups design, ops')
  })

  it('describe a site in one line, with its review page when it has one', () => {
    expect(describeSharedSite(site(true, []))).toBe(
      '- plan: https://plan.sites.example.test/ (shared by ann@example.test, through your address)'
    )
    expect(
      describeSharedSite({
        ...site(false, ['design']),
        reviewUrl: 'https://fling.test/review/plan',
      })
    ).toBe(
      '- plan: https://plan.sites.example.test/ (shared by ann@example.test, through group design; review: https://fling.test/review/plan)'
    )
  })
})
