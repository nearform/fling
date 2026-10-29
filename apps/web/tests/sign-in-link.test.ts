import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readLinkFragment, SignInLinkForm } from '../src/pages/SignInLink'

const TOKEN = 'a'.repeat(43)

describe('the sign-in link page', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the token and address from the fragment, and nothing else', () => {
    expect(readLinkFragment(`#t=${TOKEN}&email=pat%40outside.test`)).toEqual({
      token: TOKEN,
      email: 'pat@outside.test',
    })
    expect(readLinkFragment('')).toBeNull()
    expect(readLinkFragment(`#t=${TOKEN}`)).toBeNull()
    expect(readLinkFragment('#email=pat%40outside.test')).toBeNull()
  })

  it('sends nothing until the button is pressed: a plain form, no script, no autofocus', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const html = renderToStaticMarkup(
      createElement(SignInLinkForm, {
        instance: 'Acme Fling',
        link: { token: TOKEN, email: 'pat@outside.test' },
      })
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(html).toMatch(/^<form method="post" action="\/auth\/link\/verify">/)
    expect(html).toContain(`<input type="hidden" name="t" value="${TOKEN}"/>`)
    expect(html).toContain('<button type="submit"')
    expect(html).toContain('pat@outside.test')
    expect(html).not.toMatch(/autofocus|<script|onload/i)
  })
})
