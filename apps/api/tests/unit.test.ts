import { describe, expect, it } from 'vitest'
import { validateCliRedirectUri } from '../src/auth/cli.ts'
import { admitGoogleClaims } from '../src/auth/google.ts'
import { safeReturnUrl } from '../src/auth/return-url.ts'
import { Records } from '../src/store/records.ts'
import { slugCandidate } from '../src/store/types.ts'
import { MemoryTable } from '../src/table/memory.ts'

describe('admitGoogleClaims', () => {
  const allowed = ['example.test']
  it('admits a verified allowed-domain email', () => {
    expect(
      admitGoogleClaims(
        { email: 'Alice@Example.test', email_verified: true, hd: 'example.test', name: 'Alice' },
        allowed
      )
    ).toEqual({ ok: true, email: 'alice@example.test', name: 'Alice', picture: null })
  })
  it.each([
    [{ email: 'a@example.test', email_verified: false }, 'email_unverified'],
    [{ email: 'a@example.test' }, 'email_unverified'],
    [{ email_verified: true }, 'email_unverified'],
    [{ email: 'a@gmail.com', email_verified: true }, 'domain_not_allowed'],
    [{ email: 'a@evil.example.test', email_verified: true }, 'domain_not_allowed'],
    [{ email: 'a@example.test.evil.io', email_verified: true }, 'domain_not_allowed'],
    [{ email: 'a@example.test', email_verified: true, hd: 'other.com' }, 'domain_not_allowed'],
  ])('rejects %j', (claims, reason) => {
    expect(admitGoogleClaims(claims, allowed)).toEqual({ ok: false, reason })
  })
  it('supports several domains', () => {
    expect(admitGoogleClaims({ email: 'a@b.io', email_verified: true }, ['x.com', 'b.io']).ok).toBe(
      true
    )
  })
})

describe('safeReturnUrl', () => {
  const cfg = {
    appOrigin: 'https://fling.example.test',
    sitesDomain: 'fling.example.test',
    siteScheme: 'https' as const,
  }
  it.each([
    ['/sites', 'https://fling.example.test/sites'],
    ['https://fling.example.test/auth/cli?x=1', 'https://fling.example.test/auth/cli?x=1'],
    ['https://my-app.fling.example.test/a?b=c', 'https://my-app.fling.example.test/a?b=c'],
    [
      'https://s--abcdefghij0123456789.fling.example.test/',
      'https://s--abcdefghij0123456789.fling.example.test/',
    ],
  ])('allows %s', (input, out) => {
    expect(safeReturnUrl(input, cfg)).toBe(out)
  })
  it.each([
    undefined,
    '',
    '//evil.com/x',
    '/\\evil.com',
    'https://evil.com/',
    'http://my-app.fling.example.test/',
    'https://app--bob.fling.example.test/',
    'https://s--short.fling.example.test/',
    'https://www.fling.example.test/',
    'https://fling.example.test.evil.com/',
    'https://evilfling.example.test/',
    'https://a.b.fling.example.test/',
    'https://user:pw@my-app.fling.example.test/',
    'javascript:alert(1)',
    'https://fling.example.test:444/',
  ])('rejects %s', input => {
    expect(safeReturnUrl(input, cfg)).toBe('/')
  })
  it('handles dev hosts with ports', () => {
    const dev = {
      appOrigin: 'http://localhost:47101',
      sitesDomain: 'localhost:47102',
      siteScheme: 'http' as const,
    }
    expect(safeReturnUrl('http://hello.localhost:47102/', dev)).toBe(
      'http://hello.localhost:47102/'
    )
    expect(safeReturnUrl('http://hello.localhost:9999/', dev)).toBe('/')
  })
})

describe('validateCliRedirectUri', () => {
  it.each(['http://127.0.0.1:53123/callback', 'http://localhost:8080/callback'])(
    'accepts %s',
    uri => {
      expect(validateCliRedirectUri(uri)?.toString()).toBe(uri)
    }
  )
  it.each([
    undefined,
    'not a url',
    'https://127.0.0.1:53123/callback',
    'http://127.0.0.1/callback',
    'http://127.0.0.2:5000/callback',
    'http://evil.com:5000/callback',
    'http://127.0.0.1.evil.com:5000/callback',
    'http://127.0.0.1:5000/other',
    'http://127.0.0.1:5000/callback?x=1',
    'http://u:p@127.0.0.1:5000/callback',
  ])('rejects %s', uri => {
    expect(validateCliRedirectUri(uri)).toBeNull()
  })
})

describe('user slugs', () => {
  it('are unique per email', async () => {
    const store = new Records(new MemoryTable())
    const now = new Date().toISOString()
    const a = await store.upsertUser(
      { email: 'a.b@x.com', name: 'A', picture: null, preferredSlug: 'a-b' },
      now
    )
    const b = await store.upsertUser(
      { email: 'a-b@x.com', name: 'B', picture: null, preferredSlug: 'a-b' },
      now
    )
    const again = await store.upsertUser(
      { email: 'a.b@x.com', name: 'A2', picture: null, preferredSlug: 'a-b' },
      now
    )
    expect([a.userSlug, b.userSlug, again.userSlug]).toEqual(['a-b', 'a-b-2', 'a-b'])
    expect(again.name).toBe('A2')
    expect(slugCandidate('abcdefghijklmnopqrst', 1)).toBe('abcdefghijklmnopqr-2')
  })
})
