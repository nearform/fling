import { describe, expect, it } from 'vitest'
import { validateCliRedirectUri } from '../src/auth/cli.ts'
import { admitIdentity, type Identity } from '../src/auth/identity.ts'
import { safeReturnUrl } from '../src/auth/return-url.ts'
import { newCommentId } from '../src/lib/ids.ts'
import { Records } from '../src/store/records.ts'
import { slugCandidate } from '../src/store/types.ts'
import { MemoryTable } from '../src/table/memory.ts'

describe('admitIdentity', () => {
  const policy = { allowedDomains: ['example.test'] }
  const id = (claims: Omit<Identity, 'subject'>): Identity => ({ subject: 'sub', ...claims })
  it('admits a verified allowed-domain email', () => {
    expect(
      admitIdentity(
        id({ email: 'Alice@Example.test', emailVerified: true, hd: 'example.test', name: 'Alice' }),
        policy
      )
    ).toEqual({ ok: true, email: 'alice@example.test', name: 'Alice', picture: null })
  })
  it.each([
    [{ email: 'a@example.test', emailVerified: false }, 'email_unverified'],
    [{ email: 'a@example.test' }, 'email_unverified'],
    [{ emailVerified: true }, 'email_unverified'],
    [{ email: 'a@elsewhere.test', emailVerified: true }, 'domain_not_allowed'],
    [{ email: 'a@evil.example.test', emailVerified: true }, 'domain_not_allowed'],
    [{ email: 'a@example.test.evil.io', emailVerified: true }, 'domain_not_allowed'],
    [{ email: 'a@example.test', emailVerified: true, hd: 'other.test' }, 'domain_not_allowed'],
  ])('rejects %j', (claims, reason) => {
    expect(admitIdentity(id(claims), policy)).toEqual({ ok: false, reason })
  })
  it('supports several domains', () => {
    const several = { allowedDomains: ['x.test', 'b.test'] }
    expect(admitIdentity(id({ email: 'a@b.test', emailVerified: true }), several).ok).toBe(true)
  })
  describe('with ALLOWED_EMAILS', () => {
    const invited = { allowedDomains: ['example.test'], allowedEmails: ['me@gmail.test'] }
    const personal = { allowedDomains: [], allowedEmails: ['me@gmail.test'] }
    it('admits a listed address on an unlisted domain, case-insensitively', () => {
      for (const p of [invited, personal]) {
        expect(admitIdentity(id({ email: 'Me@Gmail.TEST', emailVerified: true }), p)).toEqual({
          ok: true,
          email: 'me@gmail.test',
          name: 'me',
          picture: null,
        })
      }
      const upper = { allowedDomains: [], allowedEmails: ['ME@GMAIL.TEST'] }
      expect(admitIdentity(id({ email: 'me@gmail.test', emailVerified: true }), upper).ok).toBe(
        true
      )
    })
    it('still admits the allowed domains', () => {
      expect(admitIdentity(id({ email: 'a@example.test', emailVerified: true }), invited).ok).toBe(
        true
      )
    })
    it.each([
      [{ email: 'you@gmail.test', emailVerified: true }, 'domain_not_allowed'],
      [{ email: 'a@example.test', emailVerified: true }, 'domain_not_allowed'],
      [{ email: 'me@gmail.test.evil.io', emailVerified: true }, 'domain_not_allowed'],
      [{ email: 'me@gmail.test', emailVerified: false }, 'email_unverified'],
      [{ email: 'me@gmail.test' }, 'email_unverified'],
      [{ email: 'me@gmail.test', emailVerified: true, hd: 'example.test' }, 'domain_not_allowed'],
    ])('a personal instance rejects %j', (claims, reason) => {
      expect(admitIdentity(id(claims), personal)).toEqual({ ok: false, reason })
    })
  })
  it('assumeEmailVerified covers a missing claim only', () => {
    const trusting = { ...policy, assumeEmailVerified: true }
    expect(admitIdentity(id({ email: 'a@example.test' }), trusting).ok).toBe(true)
    expect(admitIdentity(id({ email: 'a@example.test', emailVerified: false }), trusting)).toEqual({
      ok: false,
      reason: 'email_unverified',
    })
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

describe('newCommentId', () => {
  it('sorts by creation time in byte order, whatever the year', () => {
    const times = [
      '1970-01-01T00:00:00.001Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.001Z',
      '2400-06-01T00:00:00.000Z',
    ]
    const ids = times.map(t => newCommentId(new Date(t)))
    for (const id of ids) expect(id).toMatch(/^[0-9a-v]{18}$/)
    expect([...ids].sort()).toEqual(ids)
    expect(newCommentId(new Date(0))).not.toBe(newCommentId(new Date(0)))
  })
})
