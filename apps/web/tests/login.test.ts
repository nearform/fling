import type { InstanceMetadata } from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { loginErrorMessage } from '../src/pages/Login'

const instance = (emailDomains: string[], invitedEmails?: boolean) =>
  ({
    version: 1,
    name: 'Acme Fling',
    appOrigin: 'https://fling.example.test',
    sitesDomain: 'sites.example.test',
    siteScheme: 'https',
    auth: { kind: 'oidc', displayName: 'Google', emailDomains, invitedEmails },
    brand: { colors: {} },
    capabilities: {},
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
