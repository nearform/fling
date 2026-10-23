import { describe, expect, it } from 'vitest'
import {
  initialsFromEmail,
  isValidSiteName,
  nameSuggestions,
  parseLabel,
  siteLabel,
  slugify,
  userSlugFromEmail,
} from '../src/hosts.ts'
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
    expect(userSlugFromEmail('Clifton.Cunningham@nearform.com')).toBe('clifton-cunningham')
  })
  it('parses labels', () => {
    expect(parseLabel(siteLabel('my-app'))).toEqual({ kind: 'site', name: 'my-app' })
    expect(parseLabel(`s--${'a'.repeat(20)}`)).toEqual({ kind: 'share', token: 'a'.repeat(20) })
    expect(parseLabel('s--short')).toBeNull()
    expect(parseLabel('www')).toBeNull()
    expect(parseLabel('a--b')).toBeNull()
  })
  it('derives initials and clash suggestions', () => {
    expect(initialsFromEmail('clifton.cunningham@nearform.com')).toBe('cc')
    expect(initialsFromEmail('mary-jane_watson@nearform.com')).toBe('mjw')
    expect(initialsFromEmail('bob@nearform.com')).toBe('bo')
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
    const c = signSiteCookie({ e: 'a@nearform.com', x: 2000 }, 'k')
    expect(verifySiteCookie(c, 'k', 1000)).toEqual({ e: 'a@nearform.com', x: 2000 })
    expect(verifySiteCookie(c, 'other', 1000)).toBeNull()
    expect(verifySiteCookie(c, 'k', 3000)).toBeNull()
    expect(verifySiteCookie(`${c}x`, 'k', 1000)).toBeNull()
  })
})
