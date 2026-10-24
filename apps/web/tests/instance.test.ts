import { describe, expect, it } from 'vitest'
import { brandVars, notFoundAppOrigin, npxCommandFor, safeAssetUrl } from '../src/lib/instance'

describe('brandVars', () => {
  it('maps brand colours onto the theme inputs', () => {
    expect(
      brandVars({
        colors: {
          primary: '#00e5a4',
          primaryContent: '#000',
          accent: '#166BFF',
          ink: '#000e38',
          highlight: '#8950ff',
        },
      })
    ).toEqual({
      '--brand-primary': '#00e5a4',
      '--brand-primary-content': '#000',
      '--brand-accent': '#166BFF',
      '--brand-ink': '#000e38',
      '--brand-highlight': '#8950ff',
    })
  })

  it('is empty for no brand', () => {
    expect(brandVars(undefined)).toEqual({})
    expect(brandVars(null)).toEqual({})
    expect(brandVars({ colors: {} })).toEqual({})
  })

  it('drops anything that is not a hex colour, and unknown keys', () => {
    expect(
      brandVars({
        colors: {
          primary: 'red; background: url(x)',
          accent: 'oklch(50% 0.2 260)',
          ink: '#12345',
          highlight: '#abc',
          evil: '#fff',
        },
      })
    ).toEqual({ '--brand-highlight': '#abc' })
  })
})

describe('safeAssetUrl', () => {
  it('accepts http(s) and data:image only', () => {
    expect(safeAssetUrl('https://cdn.example.test/logo.svg')).toBe(
      'https://cdn.example.test/logo.svg'
    )
    expect(safeAssetUrl('data:image/svg+xml,%3Csvg%3E')).toBe('data:image/svg+xml,%3Csvg%3E')
    expect(safeAssetUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeAssetUrl('data:text/html,x')).toBeUndefined()
    expect(safeAssetUrl(undefined)).toBeUndefined()
  })
})

describe('notFoundAppOrigin', () => {
  const at = new URL('https://my-app.sites.example.test/missing')

  it('uses the origin the deploy filled in', () => {
    expect(notFoundAppOrigin('https://fling.example.test/', at)).toBe('https://fling.example.test')
  })

  it("falls back to the site host's parent when the placeholder is still there", () => {
    expect(notFoundAppOrigin('__APP_ORIGIN__', at)).toBe('https://sites.example.test')
    expect(notFoundAppOrigin(null, new URL('http://x.fling.lvh.me:47102/'))).toBe(
      'http://fling.lvh.me:47102'
    )
    expect(notFoundAppOrigin('not a url', at)).toBe('https://sites.example.test')
  })
})

describe('npxCommandFor', () => {
  it('derives npx from a plain global npm install', () => {
    expect(npxCommandFor('npm install -g @acme/fling')).toBe('npx @acme/fling')
    expect(npxCommandFor('npm i -g fling-cli')).toBe('npx fling-cli')
    expect(npxCommandFor('brew install fling')).toBeNull()
  })
})
