import { describe, expect, it } from 'vitest'
import { validateCliRedirectUri } from '../src/auth/cli.ts'
import { admitGoogleClaims } from '../src/auth/google.ts'
import { safeReturnUrl } from '../src/auth/return-url.ts'
import { Records } from '../src/store/records.ts'
import { slugCandidate } from '../src/store/types.ts'
import { MemoryTable } from '../src/table/memory.ts'

describe('admitGoogleClaims', () => {
  const allowed = ['nearform.com']
  it('admits a verified allowed-domain email', () => {
    expect(
      admitGoogleClaims(
        { email: 'Alice@Nearform.com', email_verified: true, hd: 'nearform.com', name: 'Alice' },
        allowed
      )
    ).toEqual({ ok: true, email: 'alice@nearform.com', name: 'Alice', picture: null })
  })
  it.each([
    [{ email: 'a@nearform.com', email_verified: false }, 'email_unverified'],
    [{ email: 'a@nearform.com' }, 'email_unverified'],
    [{ email_verified: true }, 'email_unverified'],
    [{ email: 'a@gmail.com', email_verified: true }, 'domain_not_allowed'],
    [{ email: 'a@evil.nearform.com', email_verified: true }, 'domain_not_allowed'],
    [{ email: 'a@nearform.com.evil.io', email_verified: true }, 'domain_not_allowed'],
    [{ email: 'a@nearform.com', email_verified: true, hd: 'other.com' }, 'domain_not_allowed'],
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
    appOrigin: 'https://fling.labs.nearform.com',
    sitesDomain: 'fling.labs.nearform.com',
    siteScheme: 'https' as const,
  }
  it.each([
    ['/sites', 'https://fling.labs.nearform.com/sites'],
    [
      'https://fling.labs.nearform.com/auth/cli?x=1',
      'https://fling.labs.nearform.com/auth/cli?x=1',
    ],
    [
      'https://my-app.fling.labs.nearform.com/a?b=c',
      'https://my-app.fling.labs.nearform.com/a?b=c',
    ],
    [
      'https://s--abcdefghij0123456789.fling.labs.nearform.com/',
      'https://s--abcdefghij0123456789.fling.labs.nearform.com/',
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
    'http://my-app.fling.labs.nearform.com/',
    'https://app--bob.fling.labs.nearform.com/',
    'https://s--short.fling.labs.nearform.com/',
    'https://www.fling.labs.nearform.com/',
    'https://fling.labs.nearform.com.evil.com/',
    'https://evilfling.labs.nearform.com/',
    'https://a.b.fling.labs.nearform.com/',
    'https://user:pw@my-app.fling.labs.nearform.com/',
    'javascript:alert(1)',
    'https://fling.labs.nearform.com:444/',
  ])('rejects %s', input => {
    expect(safeReturnUrl(input, cfg)).toBe('/')
  })
  it('handles dev hosts with ports', () => {
    const dev = {
      appOrigin: 'http://localhost:3001',
      sitesDomain: 'localhost:3002',
      siteScheme: 'http' as const,
    }
    expect(safeReturnUrl('http://hello.localhost:3002/', dev)).toBe('http://hello.localhost:3002/')
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
