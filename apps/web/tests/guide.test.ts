// The Guide's pages keep their contract: frontmatter, placeholders and facts that resolve, gates
// on capabilities that exist, links and anchors that land, nothing instance-specific written in.
import { readFileSync } from 'node:fs'
import {
  CAPABILITY_NAMES,
  GUIDE_FACTS,
  GUIDE_PARTS,
  GUIDE_SLUG_RE,
  type GuideContext,
  type GuidePage,
  guidePageVisible,
  PINNED_GUIDE_FACTS,
  resolveGuideText,
} from '@fling/shared'
import { describe, expect, it } from 'vitest'
import { GUIDE_PAGES } from '../src/guide/content'
import { renderGuideMarkdown } from '../src/guide/render'
import { searchGuide } from '../src/guide/search'

const everything: GuideContext = {
  instance: {
    origin: 'https://fling.example.test',
    name: 'Fling',
    mcp: 'https://fling.example.test/mcp',
    install: 'npm install -g fling-cli',
    sites: 'sites.example.test',
    account: 'your Example account',
    audience: 'anyone signed in to Fling',
  },
  siteUrl: name => `https://${name}.sites.example.test`,
  facts: GUIDE_FACTS,
  reader: { capabilities: Object.fromEntries(CAPABILITY_NAMES.map(c => [c, true])), admin: true },
}

const resolved = (page: GuidePage) => resolveGuideText(page.body, everything)
const ids = (html: string) => new Set([...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]))
const bySlug = new Map(GUIDE_PAGES.map(p => [p.slug, p]))

describe('the Guide pages', () => {
  it('exist in every part, at addresses the platforms serve as deep links', () => {
    for (const part of GUIDE_PARTS) {
      expect(
        GUIDE_PAGES.some(p => p.meta.part === part.id),
        part.id
      ).toBe(true)
    }
    for (const page of GUIDE_PAGES) expect(page.slug).toMatch(GUIDE_SLUG_RE)
  })

  it('gate only on capabilities an instance can advertise', () => {
    for (const page of GUIDE_PAGES) {
      const gates = [
        ...page.meta.requires,
        ...[...page.body.matchAll(/<!--\s*requires:\s*([^>]+?)\s*-->/g)].flatMap(m =>
          (m[1] ?? '').split(',').map(s => s.trim())
        ),
      ]
      for (const gate of gates) expect(CAPABILITY_NAMES, `${page.slug}: ${gate}`).toContain(gate)
    }
  })

  it('fill every placeholder and close every gated passage', () => {
    for (const page of GUIDE_PAGES) {
      const { text, unknown } = resolved(page)
      expect(unknown, page.slug).toEqual([])
      expect(text, page.slug).not.toMatch(/\{\{\s*(instance|fact):/)
      expect(text, page.slug).not.toMatch(/<!--\s*\/?requires/)
    }
  })

  it('link only to pages and sections that exist', () => {
    let checked = 0
    for (const page of GUIDE_PAGES) {
      const { html } = renderGuideMarkdown(resolved(page).text)
      for (const [, href] of html.matchAll(/<a href="([^"]+)"/g)) {
        if (!href || /^https?:/.test(href)) continue
        const url = new URL(href, `https://x/guide/${page.slug}`)
        if (!url.pathname.startsWith('/guide')) continue
        checked++
        const slug = url.pathname.replace(/^\/guide\/?/, '').replace(/\/$/, '')
        const target = slug ? bySlug.get(slug) : GUIDE_PAGES[0]
        expect(target, `${page.slug} → ${href}`).toBeDefined()
        if (target && url.hash) {
          const anchors = ids(renderGuideMarkdown(resolved(target).text).html)
          expect(anchors.has(decodeURIComponent(url.hash.slice(1))), `${page.slug} → ${href}`).toBe(
            true
          )
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('name no host but the ones every instance shares: the rest are placeholders', () => {
    const allowed = /^(github\.com|claude\.ai|chatgpt\.com|nodejs\.org|www\.npmjs\.com)$/
    for (const page of GUIDE_PAGES) {
      for (const [, host = ''] of page.body.matchAll(/https?:\/\/([^\s/)`'"\]]+)/gi)) {
        // a host made of placeholders (`s--<token>.{{instance:sites}}`) is each instance's own
        if (/\{\{|</.test(host)) continue
        expect(host, page.slug).toMatch(allowed)
      }
    }
  })

  it('pin the facts other packages own at their real values', () => {
    const cli = JSON.parse(readFileSync(new URL('../../cli/package.json', import.meta.url), 'utf8'))
    expect(PINNED_GUIDE_FACTS['node-version']).toBe(String(cli.engines.node).replace(/^>=/, ''))
  })
})

describe('what a reader sees', () => {
  const page = (slug: string, meta: Partial<GuidePage['meta']>, body = ''): GuidePage => ({
    slug,
    body,
    meta: {
      title: slug,
      part: 'start',
      order: 0,
      summary: 's',
      requires: [],
      audience: 'everyone',
      sources: ['x'],
      verified: 'abcdef0',
      ...meta,
    },
  })

  it('hides pages for features the instance lacks, and admin pages from everyone else', () => {
    const reader = { capabilities: { forms: true }, admin: false }
    expect(guidePageVisible(page('a/b', { requires: ['forms'] }), reader)).toBe(true)
    expect(guidePageVisible(page('a/b', { requires: ['comments'] }), reader)).toBe(false)
    expect(guidePageVisible(page('a/b', { audience: 'admin' }), reader)).toBe(false)
    expect(guidePageVisible(page('a/b', { audience: 'admin' }), { ...reader, admin: true })).toBe(
      true
    )
  })

  it('drops passages for features the instance lacks', () => {
    const body = 'a <!-- requires: forms -->B<!-- /requires --> c'
    const off = { ...everything, reader: { capabilities: {}, admin: false } }
    expect(resolveGuideText(body, everything).text).toBe('a B c')
    expect(resolveGuideText(body, off).text).toBe('a  c')
  })

  it('finds pages by every word, titles first', () => {
    const pages = [
      page('start/a', { title: 'Share links' }, 'nothing'),
      page('start/b', { title: 'Other' }, 'make a share link here'),
    ]
    expect(searchGuide(pages, 'share LINK').map(p => p.slug)).toEqual(['start/a', 'start/b'])
    expect(searchGuide(pages, 'zebra')).toEqual([])
  })

  it('renders headings with ids, guide links in-app and other links in a new tab', () => {
    const { html, outline, title } = renderGuideMarkdown(
      '# T\n\n## On the command line\n\n[a](/guide/x/y) [b](https://github.com/)\n\n> **Note** hi'
    )
    expect(title).toBe('T')
    expect(outline).toEqual([{ id: 'on-the-command-line', text: 'On the command line' }])
    expect(html).toContain('<a href="/guide/x/y">a</a>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('class="guide-callout"')
  })
})
