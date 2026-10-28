import { describe, expect, it } from 'vitest'
import {
  acceptSuggestion,
  completeEntries,
  currentEntry,
  domainSuggestions,
  inlineCompletion,
} from '../src/lib/email-complete'

const ONE = ['example.com']
const TWO = ['example.com', 'example.org', 'other.test']

describe('the entry being typed', () => {
  it('is what follows the last comma, semicolon or space', () => {
    expect(currentEntry('a@x.test, bo')).toEqual({ head: 'a@x.test, ', entry: 'bo' })
    expect(currentEntry('bo')).toEqual({ head: '', entry: 'bo' })
    expect(currentEntry('a@x.test; ')).toEqual({ head: 'a@x.test; ', entry: '' })
  })
})

describe('suggesting addresses from the allowed domains', () => {
  it('offers each domain for a name, and those that start with what follows the @', () => {
    expect(domainSuggestions('ann', TWO)).toEqual([
      'ann@example.com',
      'ann@example.org',
      'ann@other.test',
    ])
    expect(domainSuggestions('ann@', TWO)).toHaveLength(3)
    expect(domainSuggestions('ann@Ex', TWO)).toEqual(['ann@example.com', 'ann@example.org'])
    expect(domainSuggestions('ann@gmail', TWO)).toEqual([])
  })

  it('offers nothing without a name, once the domain is complete, or with no domains', () => {
    expect(domainSuggestions('', TWO)).toEqual([])
    expect(domainSuggestions('@ex', TWO)).toEqual([])
    expect(domainSuggestions('ann@example.com', TWO)).toEqual([])
    expect(domainSuggestions('a@b@c', TWO)).toEqual([])
    expect(domainSuggestions('ann', [])).toEqual([])
  })
})

describe('ghost text with one allowed domain', () => {
  it('is the rest of the address for the last entry', () => {
    expect(inlineCompletion('clifton', ONE)).toBe('@example.com')
    expect(inlineCompletion('a@x.test, clifton@exa', ONE)).toBe('mple.com')
  })

  it('is absent with several domains, none, another domain or nothing typed', () => {
    expect(inlineCompletion('clifton', TWO)).toBeNull()
    expect(inlineCompletion('clifton', [])).toBeNull()
    expect(inlineCompletion('clifton@gmail.test', ONE)).toBeNull()
    expect(inlineCompletion('a@example.com, ', ONE)).toBeNull()
  })

  it('accepting a suggestion replaces only the last entry', () => {
    expect(acceptSuggestion('a@x.test, ann@ex', 'ann@example.org')).toBe(
      'a@x.test, ann@example.org'
    )
  })
})

describe('completing a pasted list', () => {
  it('gives entries without a domain the one allowed domain, leaving full addresses alone', () => {
    expect(completeEntries('ann, bo@\ncy@gmail.test;dee', ONE)).toBe(
      'ann@example.com, bo@example.com, cy@gmail.test, dee@example.com'
    )
  })

  it('leaves the text as it is with several domains or none', () => {
    expect(completeEntries('ann, bo', TWO)).toBe('ann, bo')
    expect(completeEntries('ann, bo', [])).toBe('ann, bo')
  })
})
