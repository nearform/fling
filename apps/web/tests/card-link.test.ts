import { describe, expect, it } from 'vitest'
import { siteCardTarget } from '../src/components/CardLink'

const site = { name: 'demo', url: 'https://demo.sites.example.test/' }

describe('siteCardTarget', () => {
  it('leads whoever manages the site (owner, publisher, admin) to its site page', () => {
    for (const reviewable of [true, false]) {
      expect(siteCardTarget(site, { manages: true, reviewable })).toEqual({
        kind: 'site-page',
        to: '/sites/demo',
      })
    }
  })

  it('leads anyone else to its review page, or to the site when there are no comments', () => {
    expect(siteCardTarget(site, { manages: false, reviewable: true })).toEqual({
      kind: 'review',
      to: '/review/demo',
    })
    expect(siteCardTarget(site, { manages: false, reviewable: false })).toEqual({
      kind: 'site',
      href: site.url,
    })
  })
})
