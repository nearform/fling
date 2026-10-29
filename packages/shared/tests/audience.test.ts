import { describe, expect, it } from 'vitest'
import { accessChangeHint } from '../src/access.ts'
import { audienceList, describeSharedSite, sharedVia } from '../src/audience.ts'
import { mcpToolsFor, mcpWording } from '../src/mcp-tools.ts'

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

describe('people from outside', () => {
  const instance = (invites: boolean) => ({
    name: 'Acme Fling',
    sitesDomain: 'sites.example.test',
    siteScheme: 'https' as const,
    auth: { kind: 'oidc', displayName: 'Example SSO', emailDomains: ['example.test'] },
    capabilities: { invites },
  })

  it('lists a guest as one', () => {
    expect(
      audienceList([
        { email: 'bob@example.test', known: true },
        { email: 'pat@outside.test', known: false, guest: true },
        { email: 'kim@outside.test', known: true, guest: true },
      ])
    ).toBe(
      "bob@example.test, pat@outside.test (guest, hasn't signed in yet), kim@outside.test (guest)"
    )
  })

  it('the access hint and the tools say outside addresses are invited, only where they are', () => {
    expect(accessChangeHint('cli', 'plan', { invites: true })).toMatch(
      /An address from outside is invited as a reviewer/
    )
    expect(accessChangeHint('mcp', 'plan')).not.toMatch(/outside/)
    const on = mcpToolsFor(mcpWording(instance(true)))
    const off = mcpToolsFor(mcpWording(instance(false)))
    for (const tool of ['setAccess', 'setAudience', 'groupCreate', 'groupMembers'] as const) {
      expect(on[tool].description).toContain('one from outside it, which is invited as a reviewer')
      expect(off[tool].description).toContain(
        'Each address must be one that can sign in to Acme Fling.'
      )
      expect(off[tool].description).not.toContain('from outside')
    }
  })
})
