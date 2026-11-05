import { describe, expect, it } from 'vitest'
import {
  checkPathsIndex,
  compareRows,
  hasPathsBlock,
  humanDate,
  matchesQuery,
  PATHS_SCRIPT,
  type PathListing,
  type PathRow,
  renderPathsIndex,
} from '../src/paths-index.ts'

const P = (folder: string, updated: string, title = '', version = `v-${folder}`): PathListing => ({
  folder,
  title,
  updated,
  version,
})

const PATHS = [
  P('PAY-9', '2026-11-01T10:00:00.000Z', 'Checkout retry'),
  P('PAY-10', '2026-11-05T09:30:00.000Z', 'Refund flow'),
  P('PAY-412', '2026-10-20T08:00:00.000Z', ''),
]

const folders = (html: string) => [...html.matchAll(/data-folder="([^"]*)"/g)].map(m => m[1])
const page = (body: string) => `<html><head><title>t</title></head><body>${body}</body></html>`

describe('hasPathsBlock', () => {
  it('finds the bare marker and a template, and not the controls marker alone', () => {
    expect(hasPathsBlock('<!-- fling:paths -->')).toBe(true)
    expect(hasPathsBlock('<!--fling:paths sort=folder-->x<!--/fling:paths-->')).toBe(true)
    expect(hasPathsBlock('<!-- fling:paths-controls -->')).toBe(false)
    expect(hasPathsBlock('<!-- fling:pathsx -->')).toBe(false)
    expect(hasPathsBlock('<p>no block</p>')).toBe(false)
  })
})

describe('renderPathsIndex: bare marker', () => {
  it('replaces the marker with the default list, newest first, linking each folder', () => {
    const { html } = renderPathsIndex(page('<!-- fling:paths -->'), PATHS)
    expect(html).not.toContain('fling:paths -->')
    expect(html).toContain('<ul class="fling-paths">')
    expect(folders(html)).toEqual(['PAY-10', 'PAY-9', 'PAY-412'])
    expect(html).toContain('<a href="./PAY-10/"><span class="fling-paths-title">Refund flow</span>')
    expect(html).toContain('<time datetime="2026-11-05T09:30:00.000Z">5 Nov 2026</time>')
  })

  it('shows the folder as the title when a Path has none', () => {
    const { html } = renderPathsIndex(page('<!-- fling:paths -->'), PATHS)
    expect(html).toContain('<span class="fling-paths-title">PAY-412</span></a>')
  })

  it('puts the row hooks on each <li>', () => {
    const { html } = renderPathsIndex(page('<!-- fling:paths -->'), [PATHS[0]])
    expect(html).toContain(
      '<li data-fling-path data-folder="PAY-9" data-title="Checkout retry" data-updated="2026-11-01T10:00:00.000Z">'
    )
  })

  it('says so when there are no Paths', () => {
    const { html } = renderPathsIndex(page('<!-- fling:paths -->'), [])
    expect(html).toContain('No Paths yet.')
    expect(html).not.toContain('data-fling-path ')
  })
})

describe('renderPathsIndex: template', () => {
  const tpl = (opts: string, item: string, empty?: string) =>
    page(
      `<ol><!-- fling:paths ${opts} -->${item}${empty === undefined ? '' : `<!-- fling:empty -->${empty}`}<!-- /fling:paths --></ol>`
    )

  it('repeats the item with every placeholder filled', () => {
    const item =
      '<li><a href="{{href}}">{{title}}</a> {{folder}} {{updated}} {{date}} {{ version }}</li>'
    const { html } = renderPathsIndex(tpl('nocontrols', item), [PATHS[1]])
    expect(html).toContain(
      '<ol><li data-fling-path data-folder="PAY-10" data-title="Refund flow" data-updated="2026-11-05T09:30:00.000Z"><a href="./PAY-10/">Refund flow</a> PAY-10 2026-11-05T09:30:00.000Z 5 Nov 2026 v-PAY-10</li></ol>'
    )
  })

  it('leaves unknown placeholders as they are', () => {
    const { html } = renderPathsIndex(tpl('', '<li>{{nope}} {{title}}</li>'), [PATHS[0]])
    expect(html).toContain('{{nope}} Checkout retry')
  })

  it('escapes every value, in text and attributes', () => {
    const nasty = P(`a<b>"c"&'d'`, '2026-11-05T00:00:00Z', `<script>alert("x")</script>&'`)
    const { html, json } = renderPathsIndex(
      tpl('', '<li title="{{title}}"><a href="{{href}}">{{folder}}</a></li>'),
      [nasty]
    )
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;"')
    expect(html).toContain('data-folder="a&lt;b&gt;&quot;c&quot;&amp;&#39;d&#39;"')
    expect(html).toContain(`href="./${encodeURIComponent(nasty.folder).replace(/'/g, '&#39;')}/"`)
    expect(html).toContain('>a&lt;b&gt;&quot;c&quot;&amp;&#39;d&#39;</a>')
    expect(JSON.parse(json).paths[0].folder).toBe(nasty.folder)
  })

  it('hooks the first element even after a comment, and wraps a text-only item', () => {
    const a = renderPathsIndex(tpl('', '<!-- <div> --> <p>{{folder}}</p><p>x</p>'), [PATHS[0]])
    expect(a.html).toContain('<!-- <div> --> <p data-fling-path data-folder="PAY-9"')
    expect(a.html).toContain('<p>x</p>')
    const b = renderPathsIndex(tpl('', '{{folder}}, '), [PATHS[0]])
    expect(b.html).toContain('<span data-fling-path data-folder="PAY-9"')
    expect(b.html).toContain('>PAY-9, </span>')
  })

  it('renders the empty section when there are no Paths, and nothing without one', () => {
    const withEmpty = renderPathsIndex(tpl('', '<li>{{folder}}</li>', '<li>None yet</li>'), [])
    expect(withEmpty.html).toContain('<ol><li>None yet</li></ol>')
    const some = renderPathsIndex(tpl('', '<li>{{folder}}</li>', '<li>None yet</li>'), PATHS)
    expect(some.html).not.toContain('None yet')
    const without = renderPathsIndex(tpl('nocontrols', '<li>{{folder}}</li>'), [])
    expect(without.html).toContain('<ol></ol>')
  })
})

describe('sort orders', () => {
  const order = (opts: string) =>
    folders(renderPathsIndex(page(`<!-- fling:paths ${opts} -->`), PATHS).html)

  it('is newest first by default and with sort=updated', () => {
    expect(order('')).toEqual(['PAY-10', 'PAY-9', 'PAY-412'])
    expect(order('sort=updated')).toEqual(['PAY-10', 'PAY-9', 'PAY-412'])
  })

  it('sorts folders naturally, so PAY-9 comes before PAY-10', () => {
    expect(order('sort=folder')).toEqual(['PAY-9', 'PAY-10', 'PAY-412'])
    expect(order('sort=folder-desc')).toEqual(['PAY-412', 'PAY-10', 'PAY-9'])
  })

  it('sorts oldest first', () => {
    expect(order('sort=oldest')).toEqual(['PAY-412', 'PAY-9', 'PAY-10'])
  })

  it('selects the block sort in the controls', () => {
    const { html } = renderPathsIndex(page('<!-- fling:paths sort=folder -->'), PATHS)
    expect(html).toContain('data-sort="folder"')
    expect(html).toContain('<option value="folder" selected>')
  })
})

describe('controls, style and script', () => {
  it('puts controls just before the listing, with style in the head and script before </body>', () => {
    const { html } = renderPathsIndex(page('<h1>x</h1><!-- fling:paths -->'), PATHS)
    expect(html).toMatch(
      /<h1>x<\/h1><div class="fling-paths-controls"[\s\S]*?<\/div><ul class="fling-paths">/
    )
    expect(html).toContain('<input type="search"')
    expect(html).toContain('<label for="fling-paths-q">Search</label>')
    expect(html).toContain('aria-live="polite">3 of 3</span>')
    expect(html).toMatch(/<style data-fling-paths-style>[\s\S]*<\/style>\n<\/head>/)
    expect(html).toMatch(/<script data-fling-paths-script>[\s\S]*<\/script>\n<\/body>/)
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html.match(/<style/g)).toHaveLength(1)
    for (const v of ['--fling-paths-accent', '--fling-paths-gap', '--fling-paths-radius']) {
      expect(html).toContain(v)
    }
  })

  it('puts controls before the list a template sits straight inside', () => {
    const list = renderPathsIndex(
      page(
        '<p>x</p><ol class="a">\n<!-- fling:paths --><li><a href="{{href}}">{{title}}</a></li><!-- /fling:paths --></ol>'
      ),
      PATHS
    ).html
    expect(list).toMatch(
      /<p>x<\/p><div class="fling-paths-controls"[\s\S]*?<\/div><ol class="a">\n<li data-fling-path/
    )
    const div = renderPathsIndex(
      page('<div class="grid"><!-- fling:paths --><p>{{folder}}</p><!-- /fling:paths --></div>'),
      PATHS
    ).html
    expect(div).toMatch(/<div class="grid"><div class="fling-paths-controls"/)
  })

  it('puts controls at the controls marker, before or after the block', () => {
    const before = renderPathsIndex(
      page('<nav><!-- fling:paths-controls --></nav><p>gap</p><!-- fling:paths -->'),
      PATHS
    ).html
    expect(before).toMatch(
      /<nav><div class="fling-paths-controls"[\s\S]*<\/div><\/nav><p>gap<\/p><ul/
    )
    const after = renderPathsIndex(
      page('<!-- fling:paths --><footer><!-- fling:paths-controls --></footer>'),
      PATHS
    ).html
    expect(after).toMatch(/<\/ul><footer><div class="fling-paths-controls"/)
    expect(after).not.toContain('fling:paths-controls -->')
  })

  it('nocontrols drops controls, script and the marker, and keeps the look', () => {
    const { html } = renderPathsIndex(
      page('<!-- fling:paths-controls --><!-- fling:paths nocontrols -->'),
      PATHS
    )
    expect(html).not.toContain('fling-paths-controls"')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('fling:paths-controls')
    expect(html).toContain('<style data-fling-paths-style>')
  })

  it('nostyle keeps only the rule that hides filtered rows', () => {
    const { html } = renderPathsIndex(page('<!-- fling:paths nostyle -->'), PATHS)
    const style = html.match(/<style data-fling-paths-style>([\s\S]*?)<\/style>/)?.[1].trim()
    expect(style).toBe('[data-fling-path][hidden]{display:none!important}')
    expect(html).toContain('<script')
  })

  it('nocontrols with nostyle adds nothing but the listing', () => {
    const { html } = renderPathsIndex(page('<!-- fling:paths nocontrols nostyle -->'), PATHS)
    expect(html).not.toMatch(/<style|<script/)
  })

  it('without a head or body, puts the style before the listing and the script at the end', () => {
    const { html } = renderPathsIndex('<!-- fling:paths -->', PATHS)
    expect(html.startsWith('<style data-fling-paths-style>')).toBe(true)
    expect(html.trimEnd().endsWith('</script>')).toBe(true)
  })

  it('ships a script that parses and contains no closing tag', () => {
    expect(() => new Function(PATHS_SCRIPT)).not.toThrow()
    expect(PATHS_SCRIPT).not.toMatch(/<\/script/i)
  })
})

describe('blocks', () => {
  it('fills only the first block', () => {
    const { html } = renderPathsIndex(
      page(
        '<!-- fling:paths nocontrols --><hr><!-- fling:paths --><ol><!-- fling:paths -->{{x}}<!-- /fling:paths --></ol>'
      ),
      [PATHS[0]]
    )
    expect(html.match(/data-fling-path /g)).toHaveLength(1)
    expect(html).toContain(
      '<hr><!-- fling:paths --><ol><!-- fling:paths -->{{x}}<!-- /fling:paths --></ol>'
    )
  })

  it('treats a template opener without its closer as a bare marker', () => {
    const { html } = renderPathsIndex(page('<!-- fling:paths --><li>{{folder}}</li>'), [PATHS[0]])
    expect(html).toContain('<ul class="fling-paths">')
    expect(html).toContain('<li>{{folder}}</li>')
  })

  it('leaves a page without a block as it is', () => {
    const src = page('<p>hello</p>')
    expect(renderPathsIndex(src, PATHS).html).toBe(src)
  })

  it('never throws, whatever the input', () => {
    const inputs = [
      '',
      '<!--',
      '<!-- fling:paths',
      '<!-- fling:paths --',
      '<!-- /fling:paths --><!-- fling:paths -->',
      '<!-- fling:paths --><!-- fling:empty -->',
      '<!-- fling:paths --><!-- fling:empty --><!-- /fling:paths -->',
      '<!-- fling:paths sort= sort=zzz --><<<{{{{}}}}<!-- /fling:paths -->',
      '<!-- fling:paths --><div<!-- /fling:paths -->',
      '<!-- fling:paths-controls --><!-- fling:paths-controls -->',
      '\u0000<!--fling:paths-->￿</HEAD></BODY>',
      `${'x'.repeat(10000)}<!-- fling:paths`,
    ]
    const odd = [P('', 'not a date'), { folder: null, title: undefined } as unknown as PathListing]
    for (const input of inputs) {
      expect(() => renderPathsIndex(input, PATHS)).not.toThrow()
      expect(() => renderPathsIndex(input, odd)).not.toThrow()
      expect(() => checkPathsIndex(input)).not.toThrow()
      expect(() => hasPathsBlock(input)).not.toThrow()
    }
    expect(() => renderPathsIndex(null, null as unknown as PathListing[])).not.toThrow()
    expect(() => checkPathsIndex(undefined as unknown as string)).not.toThrow()
  })

  it('is deterministic, whatever order the Paths arrive in', () => {
    const src = page('<!-- fling:paths -->')
    const a = renderPathsIndex(src, PATHS)
    const b = renderPathsIndex(src, [...PATHS].reverse())
    expect(b.html).toBe(a.html)
    expect(b.json).toBe(a.json)
  })
})

describe('renderPathsIndex: default page and JSON', () => {
  it('gives a complete page titled with the site name when there is no html', () => {
    const { html } = renderPathsIndex(null, PATHS, { siteName: 'Payments <team>' })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>Payments &lt;team&gt;</title>')
    expect(html).toContain('<meta name="color-scheme" content="light dark">')
    expect(html).toContain('prefers-color-scheme:dark')
    expect(html).toContain('fling-paths-controls')
    expect(folders(html)).toEqual(['PAY-10', 'PAY-9', 'PAY-412'])
  })

  it('titles the default page "Paths" without a site name', () => {
    expect(renderPathsIndex(null, []).html).toContain('<title>Paths</title>')
  })

  it('gives the listing as JSON, in the block order', () => {
    const byUpdated = JSON.parse(renderPathsIndex(null, PATHS).json)
    expect(byUpdated.paths.map((p: PathListing) => p.folder)).toEqual([
      'PAY-10',
      'PAY-9',
      'PAY-412',
    ])
    expect(byUpdated.paths[0]).toEqual(PATHS[1])
    const byFolder = JSON.parse(renderPathsIndex('<!-- fling:paths sort=folder -->', PATHS).json)
    expect(byFolder.paths.map((p: PathListing) => p.folder)).toEqual(['PAY-9', 'PAY-10', 'PAY-412'])
    const noBlock = JSON.parse(renderPathsIndex('<p>hi</p>', PATHS).json)
    expect(noBlock.paths.map((p: PathListing) => p.folder)).toEqual(['PAY-10', 'PAY-9', 'PAY-412'])
  })
})

describe('checkPathsIndex', () => {
  it('errors without a block', () => {
    const r = checkPathsIndex('<p>hi</p>')
    expect(r.ok).toBe(false)
    expect(r.block).toBeNull()
    expect(r.errors).toHaveLength(1)
  })

  it('passes a bare marker and a well-formed template', () => {
    expect(checkPathsIndex('<!-- fling:paths -->')).toEqual({
      ok: true,
      block: 'bare',
      options: [],
      warnings: [],
      errors: [],
    })
    const t = checkPathsIndex(
      '<!-- fling:paths sort=folder nostyle --><li><a href="{{href}}">{{title}}</a></li><!-- /fling:paths -->'
    )
    expect(t).toMatchObject({ ok: true, block: 'template', options: ['sort=folder', 'nostyle'] })
    expect(t.warnings).toEqual([])
  })

  it('warns about unknown options and placeholders and a missing link', () => {
    const r = checkPathsIndex(
      '<!-- fling:paths sort=size shiny --><li>{{title}} {{author}}</li><!-- /fling:paths -->'
    )
    expect(r.ok).toBe(true)
    const all = r.warnings.join('\n')
    expect(all).toContain('"sort=size"')
    expect(all).toContain('"shiny"')
    expect(all).toContain('{{author}}')
    expect(all).toContain('href="{{href}}"')
  })

  it('warns when a template is not closed', () => {
    const r = checkPathsIndex('<!-- fling:paths --><li>{{folder}}</li><!-- fling:empty -->none')
    expect(r.block).toBe('bare')
    expect(r.warnings.join()).toContain('not closed')
  })

  it('warns about a second block', () => {
    const r = checkPathsIndex('<!-- fling:paths --><!-- fling:paths -->')
    expect(r.warnings.join()).toContain('only the first')
  })
})

describe('matchesQuery', () => {
  const row: PathRow = { folder: 'PAY-412', title: 'Crème brûlée Checkout', updated: '' }

  it('matches folder or title, ignoring case and accents', () => {
    expect(matchesQuery(row, '')).toBe(true)
    expect(matchesQuery(row, '   ')).toBe(true)
    expect(matchesQuery(row, 'pay-41')).toBe(true)
    expect(matchesQuery(row, 'CREME')).toBe(true)
    expect(matchesQuery(row, 'brûlée')).toBe(true)
    expect(matchesQuery(row, 'brulee checkout')).toBe(true)
    expect(matchesQuery(row, 'brulee refund')).toBe(false)
    expect(matchesQuery(row, 'PAY-9')).toBe(false)
  })
})

describe('compareRows', () => {
  const r = (folder: string, updated = '2026-01-01T00:00:00Z'): PathRow => ({
    folder,
    title: '',
    updated,
  })

  it('orders folders naturally and case-insensitively', () => {
    const list = ['PAY-10', 'pay-2', 'PAY-9', 'PAY-009b', 'ABC', 'PAY-100'].map(f => r(f))
    expect(list.sort((a, b) => compareRows(a, b, 'folder')).map(x => x.folder)).toEqual([
      'ABC',
      'pay-2',
      'PAY-9',
      'PAY-009b',
      'PAY-10',
      'PAY-100',
    ])
  })

  it('orders by time either way and falls back to the folder', () => {
    const old = r('B', '2026-01-01T00:00:00Z')
    const recent = r('A', '2026-06-01T00:00:00Z')
    const tie = r('C', '2026-06-01T00:00:00Z')
    expect(compareRows(recent, old, 'updated')).toBeLessThan(0)
    expect(compareRows(old, recent, 'oldest')).toBeLessThan(0)
    expect(compareRows(recent, tie, 'updated')).toBeLessThan(0)
    expect(compareRows(r('A'), r('B'), 'folder-desc')).toBeGreaterThan(0)
    expect(compareRows(r('A'), r('A'), 'folder')).toBe(0)
  })
})

describe('humanDate', () => {
  it('is UTC and locale-independent', () => {
    expect(humanDate('2026-11-05T23:59:59Z')).toBe('5 Nov 2026')
    expect(humanDate('2026-11-05T23:59:59-05:00')).toBe('6 Nov 2026')
    expect(humanDate('nope')).toBe('')
  })
})

// The shipped script run against a minimal stand-in for the DOM it touches.
describe('the inline script', () => {
  type Listener = (e: Record<string, unknown>) => void
  function run(rows: PathRow[], search = '', defaultSort = 'updated') {
    const on = (target: { listeners: Record<string, Listener[]> }) => (t: string, f: Listener) => {
      target.listeners[t] ??= []
      target.listeners[t].push(f)
    }
    const parent = {
      children: [] as Record<string, unknown>[],
      insertBefore(el: Record<string, unknown>, anchor: unknown) {
        this.children.splice(this.children.indexOf(el), 1)
        const at = anchor ? this.children.indexOf(anchor as Record<string, unknown>) : -1
        if (at < 0) this.children.push(el)
        else this.children.splice(at, 0, el)
      },
    }
    for (const row of rows) {
      const attrs: Record<string, string> = {
        'data-folder': row.folder,
        'data-title': row.title,
        'data-updated': row.updated,
      }
      const el: Record<string, unknown> = {
        hidden: false,
        getAttribute: (n: string) => attrs[n] ?? null,
        parentNode: parent,
        get nextSibling() {
          return parent.children[parent.children.indexOf(el) + 1] ?? null
        },
      }
      parent.children.push(el)
    }
    const els = [...parent.children]
    const input = {
      value: '',
      listeners: {},
      focused: false,
      focus() {
        this.focused = true
      },
    } as {
      value: string
      listeners: Record<string, Listener[]>
      focused: boolean
      focus(): void
      addEventListener?: unknown
    }
    input.addEventListener = on(input)
    const values = ['updated', 'oldest', 'folder', 'folder-desc']
    const select = {
      value: defaultSort,
      options: values.map(value => ({ value })),
      listeners: {},
    } as {
      value: string
      options: { value: string }[]
      listeners: Record<string, Listener[]>
      addEventListener?: unknown
    }
    select.addEventListener = on(select)
    const count = { textContent: '' }
    const box = {
      getAttribute: (n: string) => (n === 'data-sort' ? defaultSort : null),
      querySelector: (s: string) => (s === 'input' ? input : s === 'select' ? select : count),
    }
    const doc = {
      readyState: 'complete',
      listeners: {} as Record<string, Listener[]>,
      querySelector: () => box,
      querySelectorAll: () => els,
      addEventListener: undefined as unknown,
    }
    doc.addEventListener = on(doc)
    const location = { href: `https://site.example/${search}`, search }
    const urls: string[] = []
    const history = {
      state: null,
      replaceState: (_s: unknown, _t: string, u: string) => urls.push(u),
    }
    const win: Record<string, unknown> = {}
    new Function('window', 'document', 'location', 'history', PATHS_SCRIPT)(
      win,
      doc,
      location,
      history
    )
    const shown = () =>
      parent.children
        .filter(el => !el.hidden)
        .map(el => (el.getAttribute as (n: string) => string)('data-folder'))
    const fire = (t: { listeners: Record<string, Listener[]> }, type: string, e = {}) => {
      for (const f of t.listeners[type] ?? []) f({ preventDefault() {}, ...e })
    }
    return {
      win,
      doc,
      input,
      select,
      count,
      urls,
      shown,
      fire,
      rerun: () =>
        new Function('window', 'document', 'location', 'history', PATHS_SCRIPT)(
          win,
          doc,
          location,
          history
        ),
    }
  }

  const rows: PathRow[] = [
    { folder: 'PAY-10', title: 'Refund flow', updated: '2026-11-05T00:00:00Z' },
    { folder: 'PAY-9', title: 'Crème checkout', updated: '2026-11-01T00:00:00Z' },
    { folder: 'PAY-412', title: '', updated: '2026-10-01T00:00:00Z' },
  ]

  it('filters as you type, counts, and keeps the query in the URL', () => {
    const dom = run(rows)
    expect(dom.count.textContent).toBe('3 of 3')
    dom.input.value = 'creme'
    dom.fire(dom.input, 'input')
    expect(dom.shown()).toEqual(['PAY-9'])
    expect(dom.count.textContent).toBe('1 of 3')
    expect(dom.urls.at(-1)).toBe('https://site.example/?q=creme')
  })

  it('re-sorts rows within their parent and stores a non-default sort', () => {
    const dom = run(rows)
    dom.select.value = 'folder'
    dom.fire(dom.select, 'change')
    expect(dom.shown()).toEqual(['PAY-9', 'PAY-10', 'PAY-412'])
    expect(dom.urls.at(-1)).toBe('https://site.example/?sort=folder')
    dom.select.value = 'updated'
    dom.fire(dom.select, 'change')
    expect(dom.shown()).toEqual(['PAY-10', 'PAY-9', 'PAY-412'])
    expect(dom.urls.at(-1)).toBe('https://site.example/')
  })

  it('restores state from the URL on load, ignoring an unknown sort', () => {
    const dom = run(rows, '?q=pay-4&sort=folder-desc')
    expect(dom.input.value).toBe('pay-4')
    expect(dom.select.value).toBe('folder-desc')
    expect(dom.shown()).toEqual(['PAY-412'])
    expect(run(rows, '?sort=bogus').select.value).toBe('updated')
  })

  it('focuses search on "/" unless typing, and Escape clears', () => {
    const dom = run(rows)
    dom.fire(dom.doc, 'keydown', { key: '/', target: { tagName: 'TEXTAREA' } })
    expect(dom.input.focused).toBe(false)
    dom.fire(dom.doc, 'keydown', { key: '/', target: { tagName: 'BODY' } })
    expect(dom.input.focused).toBe(true)
    dom.input.value = 'refund'
    dom.fire(dom.input, 'input')
    dom.fire(dom.input, 'keydown', { key: 'Escape' })
    expect(dom.input.value).toBe('')
    expect(dom.shown()).toHaveLength(3)
  })

  it('runs once per page', () => {
    const dom = run(rows)
    dom.rerun()
    expect(dom.input.listeners.input).toHaveLength(1)
  })
})
