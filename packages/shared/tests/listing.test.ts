import { describe, expect, it } from 'vitest'
import { extractHtmlTitle, isGeneratedListing, renderHtmlListing } from '../src/listing.ts'

describe('html listing', () => {
  it('extracts titles', () => {
    expect(extractHtmlTitle('<html><head><title> Q3 &amp; Q4\n report </title>')).toBe(
      'Q3 & Q4 report'
    )
    expect(extractHtmlTitle('<h1>no title</h1>')).toBeNull()
  })
  it('lists html pages grouped by folder, escaping and encoding', () => {
    const html = renderHtmlListing('my-site', [
      { path: 'b.html', title: 'Bee <script>' },
      { path: 'a page.html' },
      { path: 'docs/intro.htm', title: 'Intro' },
      { path: 'style.css' },
      { path: 'index.html' },
    ])
    expect(html).toContain('<a href="a%20page.html">a page.html</a>')
    expect(html).toContain('Bee &lt;script&gt;')
    expect(html).toContain('<h2>docs/</h2>')
    expect(html).toContain('href="docs/intro.htm"')
    expect(html).not.toContain('style.css')
    expect(html).toContain('3 pages')
    expect(html.indexOf('a%20page')).toBeLessThan(html.indexOf('<h2>docs/'))
  })
  it('handles no pages', () => {
    expect(renderHtmlListing('x', [])).toContain('No HTML pages')
  })

  it('recognises a generated listing by its generator marker', () => {
    expect(isGeneratedListing(renderHtmlListing('x', [{ path: 'a.html' }]))).toBe(true)
    expect(isGeneratedListing('<!doctype html><title>Mine</title><h1>hi</h1>')).toBe(false)
    expect(isGeneratedListing('<meta name="generator" content="other">')).toBe(false)
  })
})
