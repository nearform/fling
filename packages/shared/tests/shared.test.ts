import { describe, expect, it } from 'vitest'
import { CACHE_IMMUTABLE, cacheControlFor, isHashedFileName } from '../src/cache-control.ts'
import {
  initialsFromEmail,
  isValidSiteName,
  nameSuggestions,
  parseLabel,
  siteLabel,
  slugify,
  userSlugFromEmail,
} from '../src/hosts.ts'
import { allowedAccountsPhrase, InstanceAuthSchema, privateAudience } from '../src/instance.ts'
import { isValidSitePath } from '../src/manifest.ts'
import { signSiteCookie, verifySiteCookie } from '../src/site-cookie.ts'
import { computeVersionId } from '../src/version-id.ts'

const sha = (c: string) => c.repeat(64)

describe('hosts', () => {
  it('slugifies', () => {
    expect(slugify('My Cool  App!')).toBe('my-cool-app')
    expect(slugify('Café--déjà')).toBe('cafe-deja')
    expect(slugify('---')).toBe('')
  })
  it('validates site names', () => {
    expect(isValidSiteName('my-app')).toBe(true)
    expect(isValidSiteName('my--app')).toBe(false)
    expect(isValidSiteName('-a')).toBe(false)
    expect(isValidSiteName('a'.repeat(51))).toBe(false)
    expect(isValidSiteName('api')).toBe(false)
  })
  it('derives user slug from email', () => {
    expect(userSlugFromEmail('Clifton.Cunningham@example.test')).toBe('clifton-cunningham')
  })
  it('parses labels', () => {
    expect(parseLabel(siteLabel('my-app'))).toEqual({ kind: 'site', name: 'my-app' })
    expect(parseLabel(`s--${'a'.repeat(20)}`)).toEqual({ kind: 'share', token: 'a'.repeat(20) })
    expect(parseLabel('s--short')).toBeNull()
    expect(parseLabel('www')).toBeNull()
    expect(parseLabel('a--b')).toBeNull()
  })
  it('derives initials and clash suggestions', () => {
    expect(initialsFromEmail('clifton.cunningham@example.test')).toBe('cc')
    expect(initialsFromEmail('mary-jane_watson@example.test')).toBe('mjw')
    expect(initialsFromEmail('bob@example.test')).toBe('bo')
    expect(nameSuggestions('rocketpod-docs', 'cc', 3)).toEqual([
      'rocketpod-docs-cc',
      'rocketpod-docs-cc2',
      'rocketpod-docs-cc3',
    ])
    expect(nameSuggestions('a'.repeat(50), 'cc', 1)[0]).toHaveLength(50)
  })
})

describe('manifest', () => {
  it('rejects traversal', () => {
    expect(isValidSitePath('a/b.html')).toBe(true)
    expect(isValidSitePath('../x')).toBe(false)
    expect(isValidSitePath('/x')).toBe(false)
    expect(isValidSitePath('a//b')).toBe(false)
  })
  it('version id is order-independent and content-sensitive', () => {
    const a = [
      { path: 'index.html', sha256: sha('a') },
      { path: 'x.js', sha256: sha('b') },
    ]
    expect(computeVersionId(a)).toBe(computeVersionId([...a].reverse()))
    expect(computeVersionId(a)).not.toBe(
      computeVersionId([a[0]!, { path: 'x.js', sha256: sha('c') }])
    )
    expect(computeVersionId(a)).toMatch(/^[a-f0-9]{16}$/)
  })
})

describe('site cookie', () => {
  it('round-trips and rejects tampering/expiry', () => {
    const c = signSiteCookie({ e: 'a@example.test', x: 2000 }, 'k')
    expect(verifySiteCookie(c, 'k', 1000)).toEqual({ e: 'a@example.test', x: 2000 })
    expect(verifySiteCookie(c, 'other', 1000)).toBeNull()
    expect(verifySiteCookie(c, 'k', 3000)).toBeNull()
    expect(verifySiteCookie(`${c}x`, 'k', 1000)).toBeNull()
  })

  it("keeps a guest's mark", () => {
    const c = signSiteCookie({ e: 'g@outside.test', x: 2000, g: 1 }, 'k')
    expect(verifySiteCookie(c, 'k', 1000)).toEqual({ e: 'g@outside.test', x: 2000, g: 1 })
  })
})

describe('cacheControlFor', () => {
  it('treats content-hashed file names as immutable', () => {
    for (const p of [
      'index-Bk3x9a2Q.js',
      'assets/main.3f9a2c1b.css',
      'chunk-7XK2LQ9P.mjs',
      'app.a1b2c3d4e5.js',
      'static/js/main.3f9a2c1b.chunk.js',
    ]) {
      expect([p, isHashedFileName(p)]).toEqual([p, true])
      expect(cacheControlFor(p)).toBe(CACHE_IMMUTABLE)
    }
  })

  it('makes everything else (HTML included) revalidate in the browser, cached at the CDN', () => {
    for (const p of [
      'style.css',
      'jquery-3.7.1.min.js',
      'logo.png',
      'my-long-filename.js',
      'report-2024final.pdf',
      'index.html',
      'docs/page.html',
      'a1b2c3d4e5f6/style.css',
      'Bk3x9a2Q.js',
    ]) {
      expect([p, isHashedFileName(p)]).toEqual([p, false])
      expect(cacheControlFor(p)).toBe('public, max-age=0, must-revalidate, s-maxage=31536000')
    }
  })
})

describe('who may sign in, for copy', () => {
  const auth = (emailDomains: string[], invitedEmails?: boolean) => ({
    kind: 'oidc',
    displayName: 'Google',
    emailDomains,
    ...(invitedEmails !== undefined && { invitedEmails }),
  })
  it.each([
    [auth(['example.test']), '@example.test accounts'],
    [auth(['a.test', 'b.test']), '@a.test or @b.test accounts'],
    [auth([], true), 'invited accounts'],
    [auth(['example.test'], true), '@example.test accounts and invited accounts'],
    [auth([], false), null],
    [auth([]), null],
  ])('%j → %s', (a, phrase) => {
    expect(allowedAccountsPhrase(a)).toBe(phrase)
    expect(privateAudience({ name: 'Fling', auth: a })).toBe(
      `anyone signed in to Fling${phrase ? ` (${phrase})` : ''}`
    )
  })
  it('reads metadata with or without invitedEmails', () => {
    expect(InstanceAuthSchema.parse(auth(['example.test'])).invitedEmails).toBeUndefined()
    expect(InstanceAuthSchema.parse(auth([], true)).invitedEmails).toBe(true)
  })
})
