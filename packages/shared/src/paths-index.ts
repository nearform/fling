// The Paths index: a site's own root index.html with a Paths block that Fling fills with a listing
// of the site's live Paths, plus the same listing as JSON (`/_fling-paths.json`). The server
// re-renders it whenever a Path changes and stores the result as an immutable object, so the
// output is deterministic: the same page and Paths give byte-identical HTML and JSON.
//
// Markers, in the site's index.html (only the first block in the page is filled):
//   <!-- fling:paths [options] -->              bare: Fling's default list
//   <!-- fling:paths [options] --> item <!-- fling:empty --> empty <!-- /fling:paths -->
//                                               template: `item` repeats once per Path
//   <!-- fling:paths-controls -->               where the search and sort controls go; without
//                                               it, just before the listing (or before the list
//                                               or table a template sits straight inside)
// Options: `sort=updated` (newest first, the default), `sort=oldest`, `sort=folder` (A–Z, natural
// order), `sort=folder-desc`, `nocontrols`, `nostyle`. A template opener without its closer is a
// bare marker. Placeholders in a template item: {{href}} {{folder}} {{title}} {{updated}} {{date}}
// {{version}}, all HTML-escaped; {{title}} falls back to the folder when the Path has no title.
//
// The listing is complete HTML without script. The controls' inline script is progressive
// enhancement, and it is built from `matchesQuery` and `compareRows` themselves (their source
// text), so the tests of those functions cover what ships. That is why both are self-contained:
// no references outside their own bodies and no nested named functions or arrow constants.
// Pure: no Node built-ins, no dependencies, never throws on any HTML.

export interface PathListing {
  folder: string
  title: string
  /** ISO 8601. */
  updated: string
  version: string
}

/** What the filter and sort read from a row: the listing, or a row's `data-*` hooks. */
export interface PathRow {
  folder: string
  title: string
  updated: string
}

export const PATHS_SORTS = ['updated', 'oldest', 'folder', 'folder-desc'] as const
/** `updated`: newest first; `oldest`; `folder`: A–Z, numbers in order (PAY-9 before PAY-10). */
export type PathsSort = (typeof PATHS_SORTS)[number]
export const PATHS_OPTIONS = ['nocontrols', 'nostyle', ...PATHS_SORTS.map(s => `sort=${s}`)]
export const PATHS_PLACEHOLDERS = ['href', 'folder', 'title', 'updated', 'date', 'version'] as const

/**
 * Whether a row matches a search: every whitespace-separated term appears in its folder or title,
 * ignoring case and accents. An empty query matches everything.
 */
export function matchesQuery(row: PathRow, query: string): boolean {
  const marks = /[̀-ͯ]/g
  const hay = `${row.folder} ${row.title}`.normalize('NFD').replace(marks, '').toLowerCase()
  const terms = String(query).normalize('NFD').replace(marks, '').toLowerCase().split(/\s+/)
  for (let i = 0; i < terms.length; i++) {
    if (terms[i] && hay.indexOf(terms[i]) < 0) return false
  }
  return true
}

/**
 * Orders two rows for `sort`. Folders compare naturally (runs of digits as numbers, the rest
 * case-insensitively), and every order falls back to the folder, so the result is total.
 */
export function compareRows(a: PathRow, b: PathRow, sort: string): number {
  const x = String(a.folder)
  const y = String(b.folder)
  const xs = x.match(/\d+|\D+/g) || []
  const ys = y.match(/\d+|\D+/g) || []
  let byFolder = 0
  for (let i = 0; i < xs.length && i < ys.length && byFolder === 0; i++) {
    const p = xs[i]
    const q = ys[i]
    if (/^\d/.test(p) && /^\d/.test(q)) {
      const pn = p.replace(/^0+/, '')
      const qn = q.replace(/^0+/, '')
      byFolder = pn.length - qn.length || (pn < qn ? -1 : pn > qn ? 1 : 0)
    } else {
      const pl = p.toLowerCase()
      const ql = q.toLowerCase()
      byFolder = pl < ql ? -1 : pl > ql ? 1 : 0
    }
  }
  if (byFolder === 0) byFolder = xs.length - ys.length
  if (byFolder === 0) byFolder = x < y ? -1 : x > y ? 1 : 0
  const byTime = (Date.parse(a.updated) || 0) - (Date.parse(b.updated) || 0)
  if (sort === 'folder') return byFolder
  if (sort === 'folder-desc') return -byFolder
  if (sort === 'oldest') return byTime || byFolder
  return -byTime || byFolder
}

// --- Parsing -------------------------------------------------------------------------------------

const OPENER = /<!--\s*fling:paths(?=\s|-->)([\s\S]*?)-->/g
const CLOSER = /<!--\s*\/fling:paths\s*-->/g
const EMPTY = /<!--\s*fling:empty\s*-->/
const CONTROLS = /<!--\s*fling:paths-controls\s*-->/
const LIST_OPENER = /<(?:ul|ol|dl|menu|table|thead|tbody|tfoot|tr)(?=[\s>])[^<>]*>\s*$/i
const PLACEHOLDER = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g

interface Block {
  kind: 'bare' | 'template'
  start: number
  end: number
  options: string[]
  item: string
  empty: string | null
  /** More openers after this block's own. */
  more: boolean
}

function findBlock(html: string): Block | null {
  OPENER.lastIndex = 0
  const open = OPENER.exec(html)
  if (!open) return null
  const afterOpen = open.index + open[0].length
  const options = open[1].trim().split(/\s+/).filter(Boolean)
  OPENER.lastIndex = afterOpen
  const next = OPENER.exec(html)
  CLOSER.lastIndex = afterOpen
  const close = CLOSER.exec(html)
  const paired = close !== null && (next === null || close.index < next.index)
  OPENER.lastIndex = paired && close ? close.index + close[0].length : afterOpen
  const more = OPENER.exec(html) !== null
  OPENER.lastIndex = 0
  if (!paired || !close) {
    return { kind: 'bare', start: open.index, end: afterOpen, options, item: '', empty: null, more }
  }
  const inner = html.slice(afterOpen, close.index)
  const e = EMPTY.exec(inner)
  return {
    kind: 'template',
    start: open.index,
    end: close.index + close[0].length,
    options,
    item: e ? inner.slice(0, e.index) : inner,
    empty: e ? inner.slice(e.index + e[0].length) : null,
    more,
  }
}

function sortOf(options: readonly string[]): PathsSort {
  for (const o of options) {
    const s = o.startsWith('sort=') ? o.slice(5) : ''
    if ((PATHS_SORTS as readonly string[]).includes(s)) return s as PathsSort
  }
  return 'updated'
}

/** Whether the page has a Paths block for Fling to fill. */
export function hasPathsBlock(html: string): boolean {
  return typeof html === 'string' && findBlock(html) !== null
}

// --- Rendering -----------------------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[c] ?? c)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `5 Nov 2026`, in UTC and the same in every locale; empty for an unreadable date. */
export function humanDate(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

function clean(paths: readonly PathListing[]): PathListing[] {
  if (!Array.isArray(paths)) return []
  return paths
    .filter(p => p && typeof p === 'object')
    .map(p => ({
      folder: String(p.folder ?? ''),
      title: String(p.title ?? ''),
      updated: String(p.updated ?? ''),
      version: String(p.version ?? ''),
    }))
}

function values(p: PathListing): Record<string, string> {
  return {
    href: `./${encodeURIComponent(p.folder)}/`,
    folder: p.folder,
    title: p.title || p.folder,
    updated: p.updated,
    date: humanDate(p.updated),
    version: p.version,
  }
}

const rowHooks = (p: PathListing) =>
  ` data-fling-path data-folder="${esc(p.folder)}" data-title="${esc(p.title)}" data-updated="${esc(p.updated)}"`

/** Adds the row hooks to the item's first element, or wraps a text-only item in a span. */
function hookRow(item: string, p: PathListing): string {
  const tags = /<!--[\s\S]*?-->|<([A-Za-z][\w:-]*)(?=[\s/>])/g
  for (let m = tags.exec(item); m; m = tags.exec(item)) {
    if (!m[1]) continue
    const at = m.index + 1 + m[1].length
    return item.slice(0, at) + rowHooks(p) + item.slice(at)
  }
  return `<span${rowHooks(p)}>${item}</span>`
}

function fillItem(item: string, p: PathListing): string {
  const v = values(p)
  const filled = item.replace(PLACEHOLDER, (whole, name: string) =>
    Object.hasOwn(v, name) ? esc(v[name]) : whole
  )
  return hookRow(filled, p)
}

function defaultList(paths: readonly PathListing[]): string {
  if (paths.length === 0) return '<p class="fling-paths-empty">No Paths yet.</p>'
  const rows = paths.map(p => {
    const v = values(p)
    const folder =
      p.title && p.title !== p.folder
        ? ` <span class="fling-paths-folder">${esc(p.folder)}</span>`
        : ''
    const time = v.date ? ` <time datetime="${esc(p.updated)}">${esc(v.date)}</time>` : ''
    return `<li${rowHooks(p)}><a href="${esc(v.href)}"><span class="fling-paths-title">${esc(v.title)}</span>${folder}</a>${time}</li>`
  })
  return `<ul class="fling-paths">\n${rows.join('\n')}\n</ul>`
}

const SORT_LABELS: Record<PathsSort, string> = {
  updated: 'Newest',
  oldest: 'Oldest',
  folder: 'A–Z',
  'folder-desc': 'Z–A',
}

function controls(sort: PathsSort, total: number): string {
  const options = PATHS_SORTS.map(
    s => `<option value="${s}"${s === sort ? ' selected' : ''}>${SORT_LABELS[s]}</option>`
  ).join('')
  return (
    `<div class="fling-paths-controls" data-fling-paths-controls data-sort="${sort}">` +
    '<label for="fling-paths-q">Search</label>' +
    '<input type="search" id="fling-paths-q" placeholder="Search" autocomplete="off" spellcheck="false">' +
    `<label for="fling-paths-sort">Sort</label><select id="fling-paths-sort">${options}</select>` +
    `<span class="fling-paths-count" data-fling-paths-count aria-live="polite">${total} of ${total}</span>` +
    '</div>'
  )
}

// Rows hidden by the search stay hidden whatever display the page gives them; kept under
// `nostyle`, because it is what makes the search work rather than how the page looks.
const HIDE_RULE = '[data-fling-path][hidden]{display:none!important}'

const LOOK = [
  '.fling-paths-controls{display:flex;flex-wrap:wrap;align-items:center;gap:var(--fling-paths-gap,.75rem);margin:0 0 var(--fling-paths-gap,.75rem);font:inherit;color:inherit}',
  '.fling-paths-controls label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}',
  '.fling-paths-controls input,.fling-paths-controls select{font:inherit;color:inherit;background:transparent;color-scheme:inherit;accent-color:var(--fling-paths-accent,LinkText);border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:var(--fling-paths-radius,.5rem);padding:.4rem .6rem}',
  '.fling-paths-controls input{flex:1 1 14rem;min-inline-size:0}',
  '.fling-paths-controls :focus-visible{outline:2px solid var(--fling-paths-accent,LinkText);outline-offset:1px}',
  '.fling-paths-count{opacity:.7;font-size:.9em;font-variant-numeric:tabular-nums}',
  '.fling-paths{list-style:none;margin:0;padding:0;display:grid;gap:calc(var(--fling-paths-gap,.75rem)/2)}',
  '.fling-paths li{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem var(--fling-paths-gap,.75rem);padding:.6rem .8rem;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:var(--fling-paths-radius,.5rem)}',
  '.fling-paths a{color:var(--fling-paths-accent,LinkText);text-decoration:none;font-weight:600}',
  '.fling-paths a:hover{text-decoration:underline}',
  '.fling-paths-folder{font-weight:400;opacity:.7;font-family:ui-monospace,monospace;font-size:.85em;margin-inline-start:.5rem}',
  '.fling-paths time{opacity:.7;font-size:.9em;font-variant-numeric:tabular-nums}',
].join('\n')

/** The controls' inline script: plain ES2017, an idempotent IIFE, built from the exported logic. */
export const PATHS_SCRIPT = `(function () {
  var matchesQuery = (${matchesQuery.toString()});
  var compareRows = (${compareRows.toString()});
  function start() {
    if (window.__flingPaths) return;
    var box = document.querySelector('[data-fling-paths-controls]');
    if (!box) return;
    window.__flingPaths = true;
    var input = box.querySelector('input');
    var select = box.querySelector('select');
    var count = box.querySelector('[data-fling-paths-count]');
    var fallback = box.getAttribute('data-sort') || 'updated';
    var els = Array.prototype.slice.call(document.querySelectorAll('[data-fling-path]'));
    var rows = els.map(function (el) {
      return { el: el, folder: el.getAttribute('data-folder') || '', title: el.getAttribute('data-title') || '', updated: el.getAttribute('data-updated') || '' };
    });
    function rowOf(el) { return rows[els.indexOf(el)]; }
    function known(sort) {
      for (var i = 0; i < select.options.length; i++) if (select.options[i].value === sort) return true;
      return false;
    }
    function apply(write) {
      var q = input.value;
      var sort = select.value;
      var shown = 0;
      rows.forEach(function (r) {
        var ok = matchesQuery(r, q);
        r.el.hidden = !ok;
        if (ok) shown++;
      });
      var parents = [];
      rows.forEach(function (r) { if (r.el.parentNode && parents.indexOf(r.el.parentNode) < 0) parents.push(r.el.parentNode); });
      parents.forEach(function (p) {
        var group = Array.prototype.filter.call(p.children, function (el) { return els.indexOf(el) >= 0; });
        if (group.length < 2) return;
        var anchor = group[group.length - 1].nextSibling;
        group.slice().sort(function (a, b) { return compareRows(rowOf(a), rowOf(b), sort); })
          .forEach(function (el) { p.insertBefore(el, anchor); });
      });
      if (count) count.textContent = shown + ' of ' + rows.length;
      if (!write) return;
      try {
        var url = new URL(location.href);
        if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
        if (sort !== fallback) url.searchParams.set('sort', sort); else url.searchParams.delete('sort');
        history.replaceState(history.state, '', url.toString());
      } catch (e) {}
    }
    var params = new URLSearchParams(location.search);
    input.value = params.get('q') || '';
    var wanted = params.get('sort');
    if (wanted && known(wanted)) select.value = wanted;
    input.addEventListener('input', function () { apply(true); });
    select.addEventListener('change', function () { apply(true); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && input.value) { e.preventDefault(); input.value = ''; apply(true); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      var t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      input.focus();
    });
    apply(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();`

/** Inserts `text` before the first (or last) closing `tag`, or returns null when there is none. */
function insertBefore(html: string, tag: string, text: string, last: boolean): string | null {
  const lower = html.toLowerCase()
  const at = last ? lower.lastIndexOf(tag) : lower.indexOf(tag)
  return at < 0 ? null : html.slice(0, at) + text + html.slice(at)
}

function renderPage(
  html: string,
  paths: readonly PathListing[]
): { html: string; sort: PathsSort } {
  const block = findBlock(html)
  if (!block) return { html, sort: 'updated' }
  const sort = sortOf(block.options)
  const sorted = [...paths].sort((a, b) => compareRows(a, b, sort))
  const withControls = !block.options.includes('nocontrols')
  const withLook = !block.options.includes('nostyle')

  let listing: string
  if (block.kind === 'bare') listing = defaultList(sorted)
  else if (sorted.length === 0) listing = block.empty ?? ''
  else listing = sorted.map(p => fillItem(block.item, p)).join('')

  let before = html.slice(0, block.start)
  let after = html.slice(block.end)
  let middle = listing
  const panel = withControls ? controls(sort, sorted.length) : ''
  const inBefore = CONTROLS.exec(before)
  const inAfter = inBefore ? null : CONTROLS.exec(after)
  if (inBefore) before = before.replace(CONTROLS, () => panel)
  else if (inAfter) after = after.replace(CONTROLS, () => panel)
  else {
    // A template's rows usually sit straight inside a list or table, where a <div> is invalid:
    // the controls then go before that container instead.
    const container = block.kind === 'template' ? LIST_OPENER.exec(before) : null
    if (container) {
      before = before.slice(0, container.index) + panel + before.slice(container.index)
    } else middle = panel + listing
  }

  const css =
    (withControls ? HIDE_RULE : '') +
    (withControls && withLook ? '\n' : '') +
    (withLook ? LOOK : '')
  let out = before + middle + after
  if (css) {
    const style = `<style data-fling-paths-style>\n${css}\n</style>\n`
    const headed = insertBefore(before, '</head>', style, false)
    out = headed !== null ? headed + middle + after : before + style + middle + after
  }
  if (withControls) {
    const script = `<script data-fling-paths-script>\n${PATHS_SCRIPT}\n</script>\n`
    out = insertBefore(out, '</body>', script, true) ?? `${out}\n${script}`
  }
  return { html: out, sort }
}

/** A complete, neutral home page holding the default block, for a site without its own. */
export function defaultPathsPage(siteName?: string): string {
  const title = esc(siteName?.trim() || 'Paths')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1b1b1f;--fling-paths-accent:#2f5fc4}
@media (prefers-color-scheme:dark){:root{--bg:#17171a;--fg:#ececf0;--fling-paths-accent:#8ab0ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:44rem;margin:0 auto;padding:3rem 1.25rem}
h1{font-size:1.75rem;margin:0 0 1.5rem;letter-spacing:-.01em}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<!-- fling:paths -->
</main>
</body>
</html>
`
}

/**
 * Fills the page's first Paths block with `paths`, and gives the same listing as JSON in the
 * block's order. A null page is the default home page; a page without a block comes back as it is.
 */
export function renderPathsIndex(
  html: string | null,
  paths: readonly PathListing[],
  opts: { siteName?: string } = {}
): { html: string; json: string } {
  const list = clean(paths)
  const page = typeof html === 'string' ? html : defaultPathsPage(opts?.siteName)
  const rendered = renderPage(page, list)
  const ordered = [...list].sort((a, b) => compareRows(a, b, rendered.sort))
  return { html: rendered.html, json: JSON.stringify({ paths: ordered }) }
}

/** What an agent or the CLI needs to know about a page's Paths block before publishing it. */
export function checkPathsIndex(html: string): {
  ok: boolean
  block: 'bare' | 'template' | null
  options: string[]
  warnings: string[]
  errors: string[]
} {
  const page = typeof html === 'string' ? html : ''
  const warnings: string[] = []
  const errors: string[] = []
  const block = findBlock(page)
  if (!block) {
    errors.push('No Paths block: add <!-- fling:paths --> where the listing should go.')
    return { ok: false, block: null, options: [], warnings, errors }
  }
  for (const o of block.options) {
    if (!PATHS_OPTIONS.includes(o)) {
      warnings.push(`Unknown option "${o}"; the options are ${PATHS_OPTIONS.join(', ')}.`)
    }
  }
  if (block.more) warnings.push('More than one Paths block: only the first is filled.')
  CLOSER.lastIndex = 0
  const firstClose = CLOSER.exec(page)
  CLOSER.lastIndex = 0
  if (firstClose && firstClose.index < block.start) {
    warnings.push('A <!-- /fling:paths --> comes before the opening marker and is ignored.')
  }
  if (block.kind === 'bare') {
    if (EMPTY.test(page.slice(block.end)) || (firstClose && firstClose.index > block.start)) {
      warnings.push(
        'The template is not closed: add <!-- /fling:paths --> after it (before any other block). Until then the marker is bare and Fling uses its default list.'
      )
    }
  } else {
    if (!/<[A-Za-z]/.test(block.item) && !/\{\{/.test(block.item)) {
      warnings.push('The template item is empty, so each Path renders as nothing.')
    }
    const unknown = new Set<string>()
    for (const m of block.item.matchAll(PLACEHOLDER)) {
      if (!(PATHS_PLACEHOLDERS as readonly string[]).includes(m[1])) unknown.add(m[1])
    }
    for (const name of unknown) {
      warnings.push(
        `Unknown placeholder {{${name}}} is left as it is; the placeholders are ${PATHS_PLACEHOLDERS.map(p => `{{${p}}}`).join(' ')}.`
      )
    }
    if (!/href\s*=\s*["']?\{\{\s*href\s*\}\}/.test(block.item)) {
      warnings.push('The template item has no link to its Path: add <a href="{{href}}">.')
    }
  }
  const panels = page.match(new RegExp(CONTROLS.source, 'g'))?.length ?? 0
  if (panels > 0 && block.options.includes('nocontrols')) {
    warnings.push('<!-- fling:paths-controls --> is removed because the block says nocontrols.')
  }
  if (panels > 1)
    warnings.push('More than one <!-- fling:paths-controls -->: only the first is used.')
  return { ok: errors.length === 0, block: block.kind, options: block.options, warnings, errors }
}
