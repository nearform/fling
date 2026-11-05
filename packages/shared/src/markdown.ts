// Markdown pages: how a site's `.md` files are served as rendered HTML. At publish time the API
// renders each Markdown file (up to MAX_RENDERED_MARKDOWN files of at most MAX_MARKDOWN_BYTES) to a
// standalone HTML page stored beside the version at `renderedMarkdownKey(path)`; the edge serves
// that page for `/x/plan.md` and the source for `/x/plan.md?raw=1`. A folder with no `index.html`
// but with Markdown to stand in for one (markdownHomePages) gets that page as its home page.
//
// Pure and dependency-light (only `marked`), so every platform renders the same page. The page is
// GitHub-flavoured Markdown with neutral inline styles: no external assets, no instance branding
// and no script from Fling. Raw HTML in the Markdown passes through, as it is the author's own
// site; everything Fling interpolates (title, path) is escaped. Hrefs are left alone, so relative
// links to other `.md` files reach their rendered pages too.

import { Marked, type Token, type Tokens } from 'marked'
import { isMarkdownPath, MARKDOWN_EXTENSION, markdownHomePages } from './markdown-path.ts'

/** Publish renders at most this many Markdown files per version. */
export const MAX_RENDERED_MARKDOWN = 200
/** Publish renders only Markdown files up to this size, in bytes. */
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024

export { isMarkdownPath, markdownHomePages }

/**
 * Where the rendered page for a Markdown file lives inside a version's prefix. Site paths never
 * contain a segment starting with `.`, so `.rendered/` can never collide with a site file.
 */
export const renderedMarkdownKey = (path: string): string => `.rendered/${path}.html`

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** The heading's visible text: inline Markdown flattened, HTML tags dropped. */
const plainText = (tokens: readonly Token[]): string =>
  tokens
    .map(token => {
      if (token.type === 'html') return ''
      if ('tokens' in token && token.tokens) return plainText(token.tokens)
      return 'text' in token ? String(token.text) : ''
    })
    .join('')

/** GitHub-style heading ids: lower case, punctuation dropped, spaces to `-`, repeats numbered. */
const slugger = () => {
  const seen = new Map<string, number>()
  return (text: string): string => {
    const base = text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-')
    let slug = base
    let n = seen.get(base) ?? 0
    while (seen.has(slug)) slug = `${base}-${++n}`
    seen.set(base, n)
    seen.set(slug, 0)
    return slug
  }
}

const STYLE = `
:root{color-scheme:light dark;--fg:light-dark(#1f2328,#e6edf3);--muted:light-dark(#59636e,#9198a1);--bg:light-dark(#fff,#0d1117);--line:light-dark(#d1d9e0,#3d444d);--code:light-dark(#f6f8fa,#151b23);--link:light-dark(#0969da,#4493f8)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.fling-md-header,main{max-width:64rem;margin:0 auto;padding-inline:clamp(1rem,4vw,2rem)}
.fling-md-header{padding-block:.75rem;display:flex;gap:1rem;justify-content:space-between;font-size:.8125rem;color:var(--muted);border-bottom:1px solid var(--line)}
.fling-md-header span{overflow-wrap:anywhere}
main{padding-block:1.5rem 4rem;overflow-wrap:break-word}
a{color:var(--link)}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.75em 0 .6em}
h1:first-child,h2:first-child{margin-top:0}
h1,h2{padding-bottom:.3em;border-bottom:1px solid var(--line)}
code,kbd,pre,samp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:.875em}
:not(pre)>code{background:var(--code);padding:.15em .35em;border-radius:4px}
pre{background:var(--code);padding:1rem;border-radius:6px;overflow:auto;line-height:1.45}
blockquote{margin:1em 0;padding:0 1em;color:var(--muted);border-left:.25em solid var(--line)}
table{border-collapse:collapse;display:block;max-width:100%;overflow:auto;margin:1em 0}
th,td{border:1px solid var(--line);padding:.4em .8em}
th{background:var(--code)}
img,video{max-width:100%;height:auto}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
li.task-list-item{list-style:none}
li.task-list-item input{margin:0 .4em 0 -1.4em;vertical-align:middle}
`
  .trim()
  .replace(/\n/g, '')

/**
 * Renders a Markdown file to a complete HTML page. The title is the first `#` heading's text, or
 * the file name without its extension.
 */
export function renderMarkdownPage(
  source: string,
  opts: { path: string }
): { html: string; title: string } {
  const slug = slugger()
  let title: string | undefined
  const marked = new Marked({
    gfm: true,
    async: false,
    renderer: {
      heading(token: Tokens.Heading) {
        const text = plainText(token.tokens)
        if (token.depth === 1 && title === undefined) title = text.trim() || token.text.trim()
        const id = slug(text)
        const inner = this.parser.parseInline(token.tokens)
        return `<h${token.depth}${id ? ` id="${escapeHtml(id)}"` : ''}>${inner}</h${token.depth}>\n`
      },
      listitem(item: Tokens.ListItem) {
        if (!item.task) return false
        return `<li class="task-list-item">${this.parser.parse(item.tokens)}</li>\n`
      },
    },
  })
  const body = marked.parse(source) as string
  const name = fileName(opts.path)
  const pageTitle = title || name.replace(MARKDOWN_EXTENSION, '') || name
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(pageTitle)}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="fling-md-header"><span>${escapeHtml(opts.path)}</span><a href="${escapeHtml(encodeURIComponent(name))}?raw=1">View source</a></header>
<main>
${body}</main>
</body>
</html>
`
  return { html, title: pageTitle }
}
