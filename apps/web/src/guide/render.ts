/**
 * A Guide page's Markdown → HTML, with an id on every heading and the H2s as its outline. The
 * pages are written in this repository, so their HTML is trusted. Links to other pages stay
 * relative to the app (the reader turns them into in-app navigation); links elsewhere open in a
 * new tab. A blockquote that opens with **Note** or **Tip** becomes a callout.
 */
import { plainText, slugger } from '@fling/shared/markdown'
import { Marked, type Tokens } from 'marked'

export interface GuideHeading {
  id: string
  text: string
}

const escapeAttr = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

export function renderGuideMarkdown(source: string): {
  html: string
  title: string | undefined
  outline: GuideHeading[]
} {
  const slug = slugger()
  const outline: GuideHeading[] = []
  let title: string | undefined
  const marked = new Marked({
    gfm: true,
    async: false,
    renderer: {
      heading(token: Tokens.Heading) {
        const text = plainText(token.tokens).trim()
        if (token.depth === 1) {
          title ??= text
          return ''
        }
        const id = slug(text)
        if (token.depth === 2) outline.push({ id, text })
        const inner = this.parser.parseInline(token.tokens)
        return `<h${token.depth} id="${escapeAttr(id)}"><a class="guide-anchor" href="#${escapeAttr(id)}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${token.depth}>\n`
      },
      link(token: Tokens.Link) {
        const inner = this.parser.parseInline(token.tokens)
        const href = escapeAttr(token.href)
        const external = /^https?:\/\//.test(token.href)
        return external
          ? `<a href="${href}" target="_blank" rel="noreferrer">${inner}</a>`
          : `<a href="${href}">${inner}</a>`
      },
      blockquote(token: Tokens.Blockquote) {
        const body = this.parser.parse(token.tokens)
        const callout = /^<p><strong>(Note|Tip|Warning)<\/strong>/.exec(body)
        return callout
          ? `<aside class="guide-callout" data-kind="${callout[1]?.toLowerCase()}">${body}</aside>\n`
          : `<blockquote>${body}</blockquote>\n`
      },
    },
  })
  const html = marked.parse(source) as string
  return { html, title, outline }
}
