import { describe, expect, it } from 'vitest'
import {
  isMarkdownPath,
  markdownHomePages,
  renderedMarkdownKey,
  renderMarkdownPage,
} from '../src/markdown'

const render = (source: string, path = 'docs/plan.md') => renderMarkdownPage(source, { path })
const ids = (html: string) => [...html.matchAll(/<h\d id="([^"]*)"/g)].map(m => m[1])

describe('renderMarkdownPage', () => {
  it('takes the title from the first # heading', () => {
    const page = render('Intro text\n\n## Not this\n\n# The *Plan*\n\n# Later')
    expect(page.title).toBe('The Plan')
    expect(page.html).toContain('<title>The Plan</title>')
  })

  it('falls back to the file name without its extension', () => {
    expect(render('Just text', 'notes/Road-Map.markdown').title).toBe('Road-Map')
    expect(render('## Only a subheading', 'plan.md').title).toBe('plan')
  })

  it('is a standalone page with the meta tags, the path and a link to the source', () => {
    const { html } = render('# Hi')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('<meta name="viewport"')
    expect(html).toContain('<meta name="robots" content="noindex">')
    expect(html).toContain('<a href="?raw=1">View source</a>')
    expect(html).toContain('docs/plan.md')
    expect(html).toContain('color-scheme:light dark')
    expect(html).not.toMatch(/<script|<link|https?:/)
  })

  it('gives headings GitHub-style ids that are unique and stable', () => {
    const source = '# Install\n\n## Install\n\n## Install\n\n### Hello, World! `npm i`\n'
    const first = ids(render(source).html)
    expect(first).toEqual(['install', 'install-1', 'install-2', 'hello-world-npm-i'])
    expect(ids(render(source).html)).toEqual(first)
  })

  it('renders GitHub-flavoured Markdown', () => {
    const { html } = render(
      [
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '- [x] done',
        '- [ ] todo',
        '',
        '~~gone~~',
        '',
        'See https://example.com/page now.',
        '',
        '```ts',
        'const x = 1 < 2',
        '```',
      ].join('\n')
    )
    expect(html).toMatch(/<table>[\s\S]*<th>a<\/th>[\s\S]*<td>2<\/td>/)
    expect(html).toMatch(
      /<li class="task-list-item"><input checked="" disabled="" type="checkbox">/
    )
    expect(html).toMatch(/<li class="task-list-item"><input disabled="" type="checkbox">/)
    expect(html).toContain('<del>gone</del>')
    expect(html).toContain('<a href="https://example.com/page">https://example.com/page</a>')
    expect(html).toContain('<code class="language-ts">const x = 1 &lt; 2')
  })

  it('leaves relative links to other Markdown files alone', () => {
    expect(render('[next](../guide/next.md#setup)').html).toContain(
      '<a href="../guide/next.md#setup">next</a>'
    )
  })

  it('escapes the title and path it interpolates', () => {
    const { html, title } = render('# The `<script>` tag', 'a/<b>&"x".md')
    expect(title).toBe('The <script> tag')
    expect(html).toContain('<title>The &lt;script&gt; tag</title>')
    expect(html).toContain('a/&lt;b&gt;&amp;&quot;x&quot;.md')
    expect(html).not.toContain('a/<b>')
  })

  it('drops HTML tags from a heading when it becomes the title', () => {
    expect(render('# <em>Big</em> plan').title).toBe('Big plan')
  })

  it('keeps raw HTML written in the Markdown', () => {
    expect(render('<details><summary>More</summary>Body</details>').html).toContain(
      '<details><summary>More</summary>Body</details>'
    )
  })
})

describe('markdownHomePages', () => {
  it('gives no home page to a folder with an index.html', () => {
    expect(markdownHomePages(['index.html', 'README.md', 'docs/index.html', 'docs/a.md'])).toEqual(
      new Map()
    )
  })

  it('prefers index.md, then README.md, then the only Markdown file', () => {
    const pages = markdownHomePages([
      'a/README.md',
      'a/index.md',
      'a/other.md',
      'b/notes.md',
      'b/readme.MD',
      'c/only.markdown',
      'c/style.css',
    ])
    expect(pages.get('a')).toBe('a/index.md')
    expect(pages.get('b')).toBe('b/readme.MD')
    expect(pages.get('c')).toBe('c/only.markdown')
  })

  it('gives none to a folder with several loose Markdown files and no index or README', () => {
    expect(markdownHomePages(['one.md', 'two.md']).has('')).toBe(false)
  })

  it('covers the root and nested folders, each judged on the files directly in it', () => {
    const pages = markdownHomePages([
      'README.md',
      'docs/guide/intro.md',
      'docs/guide/image.png',
      'docs/api/index.html',
      'docs/api/ref.md',
      'assets/logo.png',
    ])
    expect(pages.get('')).toBe('README.md')
    expect(pages.get('docs/guide')).toBe('docs/guide/intro.md')
    expect(pages.has('docs/api')).toBe(false)
    expect(pages.has('docs')).toBe(false)
    expect(pages.has('assets')).toBe(false)
  })
})

describe('isMarkdownPath', () => {
  it('matches .md and .markdown in any case', () => {
    for (const path of ['a.md', 'x/Plan.MD', 'notes.markdown', 'B.Markdown']) {
      expect(isMarkdownPath(path)).toBe(true)
    }
    for (const path of ['a.mdx', 'md', 'a.md.html', 'readme', 'x.txt']) {
      expect(isMarkdownPath(path)).toBe(false)
    }
  })
})

describe('renderedMarkdownKey', () => {
  it('lives under a dot folder that no site path can use', () => {
    expect(renderedMarkdownKey('docs/plan.md')).toBe('.rendered/docs/plan.md.html')
  })
})
