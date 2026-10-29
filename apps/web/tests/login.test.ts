import type { InstanceMetadata } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { loginErrorMessage, opensLinkForm } from '../src/pages/Login'

const instance = (emailDomains: string[], invitedEmails?: boolean, invites?: boolean) =>
  ({
    version: 1,
    name: 'Acme Fling',
    appOrigin: 'https://fling.example.test',
    sitesDomain: 'sites.example.test',
    siteScheme: 'https',
    auth: { kind: 'oidc', displayName: 'Google', emailDomains, invitedEmails },
    brand: { colors: {} },
    capabilities: (invites === undefined ? {} : { invites }) as Record<string, boolean>,
    installCommand: 'npm install -g fling',
  }) satisfies InstanceMetadata

describe('loginErrorMessage', () => {
  it.each([
    [instance(['example.test']), 'Only @example.test accounts can sign in to Acme Fling.'],
    [instance([], true), 'Only invited accounts can sign in to Acme Fling.'],
    [
      instance(['example.test'], true),
      'Only @example.test accounts and invited accounts can sign in to Acme Fling.',
    ],
    [instance([]), "That account can't sign in to Acme Fling."],
  ])('names who may sign in, never an address', (meta, message) => {
    expect(loginErrorMessage('domain_not_allowed', meta)).toBe(message)
  })
})

describe('sign-in links on the login page', () => {
  it('points outsiders at the link form only when invitations are on', () => {
    expect(loginErrorMessage('domain_not_allowed', instance(['example.test'], false, true))).toBe(
      'Only @example.test accounts can sign in to Acme Fling. Invited from another organisation? Ask for a sign-in link below.'
    )
    expect(loginErrorMessage('domain_not_allowed', instance(['example.test'], false, false))).toBe(
      'Only @example.test accounts can sign in to Acme Fling.'
    )
  })

  it('says what is wrong with a link, and opens the form to ask for another', () => {
    const meta = instance(['example.test'], false, true)
    for (const code of ['link_expired', 'link_used', 'not_invited', 'domain_not_allowed']) {
      expect(opensLinkForm(code)).toBe(true)
      expect(loginErrorMessage(code, meta)).not.toMatch(/failed/)
    }
    expect(opensLinkForm('oauth_failed')).toBe(false)
    expect(opensLinkForm(null)).toBe(false)
  })
})
