import { describe, expect, it } from 'vitest'
import { siteTabOf, siteTabParam, siteTabsFor } from '../src/lib/site-tabs'

const everything = { access: true, server: true, settings: true }

describe('the site page’s tabs', () => {
  it('opens on Access when the address names no tab', () => {
    const tabs = siteTabsFor(everything)
    expect(siteTabOf(null, tabs)).toBe('access')
  })

  it('opens the tab ?tab= names when the viewer has it', () => {
    const tabs = siteTabsFor(everything)
    for (const tab of tabs) expect(siteTabOf(tab, tabs)).toBe(tab)
  })

  it('falls back to Access for a tab that does not exist', () => {
    expect(siteTabOf('nonsense', siteTabsFor(everything))).toBe('access')
    expect(siteTabOf('', siteTabsFor(everything))).toBe('access')
  })

  it('leaves out Server when the site has no server, secrets or a publish waiting for them', () => {
    const tabs = siteTabsFor({ ...everything, server: false })
    expect(tabs).not.toContain('server')
    expect(siteTabOf('server', tabs)).toBe('access')
  })

  it('offers Server when the site has one', () => {
    expect(siteTabsFor(everything)).toContain('server')
  })

  it('leaves out Settings for a publisher', () => {
    const tabs = siteTabsFor({ ...everything, settings: false })
    expect(tabs).not.toContain('settings')
    expect(siteTabOf('settings', tabs)).toBe('access')
  })

  it('opens on Versions when there is nothing in Access', () => {
    const tabs = siteTabsFor({ access: false, server: false, settings: true })
    expect(tabs).not.toContain('access')
    expect(siteTabOf(null, tabs)).toBe('versions')
    expect(siteTabOf('access', tabs)).toBe('versions')
  })

  it('keeps the first tab out of the address, and names every other', () => {
    const tabs = siteTabsFor(everything)
    expect(siteTabParam('access', tabs)).toBeNull()
    expect(siteTabParam('server', tabs)).toBe('server')
    const noAccess = siteTabsFor({ ...everything, access: false })
    expect(siteTabParam('versions', noAccess)).toBeNull()
  })
})
