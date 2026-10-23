// "List HTML files": when a fling has no root index.html, the CLI / MCP servers can generate one
// that links every HTML page in the site. Browser-safe and dependency-free so the CLI, the local
// MCP server and the remote connector all render the same page.

export const LISTING_GENERATOR_META = 'fling-listing'

export type ListingEntry = {
  /** site-relative POSIX path, e.g. `reports/q3.html` */
  path: string
  /** the page's <title>, if it has one */
  title?: string | null
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )

/** Percent-encode each path segment so names with spaces etc. still link correctly. */
const hrefFor = (path: string) => path.split('/').map(encodeURIComponent).join('/')

export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path)
}

/** Pull the <title> text out of an HTML document (first 64 KB is plenty). */
export function extractHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html.slice(0, 65536))
  const title = match?.[1]
    ?.replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
  return title ? title : null
}

/**
 * Render the listing page. Entries are grouped by folder (root first) and sorted by path;
 * non-HTML paths are ignored, as is a root `index.html` (there isn't one — that's why we're here).
 */
export function renderHtmlListing(siteName: string, entries: readonly ListingEntry[]): string {
  const pages = entries
    .filter(e => isHtmlPath(e.path) && e.path.toLowerCase() !== 'index.html')
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const groups = new Map<string, ListingEntry[]>()
  for (const page of pages) {
    const slash = page.path.lastIndexOf('/')
    const folder = slash === -1 ? '' : page.path.slice(0, slash)
    groups.set(folder, [...(groups.get(folder) ?? []), page])
  }

  const sections = [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a < b ? -1 : 1))
    .map(([folder, items]) => {
      const heading = folder ? `<h2>${escapeHtml(folder)}/</h2>` : ''
      const rows = items
        .map(item => {
          const file = item.path.slice(item.path.lastIndexOf('/') + 1)
          const label = item.title ? escapeHtml(item.title) : escapeHtml(file)
          const sub = item.title ? `<span class="file">${escapeHtml(file)}</span>` : ''
          return `<li><a href="${hrefFor(item.path)}">${label}</a>${sub}</li>`
        })
        .join('\n')
      return `${heading}<ul>\n${rows}\n</ul>`
    })
    .join('\n')

  const body = pages.length ? sections : '<p class="empty">No HTML pages in this fling.</p>'
  const count = `${pages.length} page${pages.length === 1 ? '' : 's'}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${LISTING_GENERATOR_META}">
<title>${escapeHtml(siteName)}</title>
<style>
  :root { color-scheme: light dark; --fg: #000e38; --muted: #5b6480; --bg: #f7f8fb; --card: #fff;
    --line: #e3e6ef; --accent: #166bff; --green: #00e5a4; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eef1f8; --muted: #9aa3bd; --bg: #000e38;
    --card: #0b1a4a; --line: #1d2c5e; --accent: #6ea2ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: var(--fg); background: var(--bg); }
  main { max-width: 760px; margin: 0 auto; padding: 48px 20px 64px; }
  header { border-left: 4px solid var(--green); padding-left: 14px; margin-bottom: 28px; }
  h1 { margin: 0; font-size: 1.6rem; }
  header p, .file, footer { color: var(--muted); font-size: .875rem; }
  header p { margin: 4px 0 0; }
  h2 { font-size: .95rem; margin: 28px 0 8px; color: var(--muted); font-weight: 600; }
  ul { list-style: none; margin: 0; padding: 0; background: var(--card); border: 1px solid var(--line);
    border-radius: 10px; overflow: hidden; }
  li { padding: 12px 16px; border-top: 1px solid var(--line); display: flex; gap: 12px;
    justify-content: space-between; align-items: baseline; flex-wrap: wrap; }
  li:first-child { border-top: 0; }
  a { color: var(--accent); text-decoration: none; font-weight: 500; }
  a:hover { text-decoration: underline; }
  .empty { color: var(--muted); }
  footer { margin-top: 40px; }
</style>
</head>
<body>
<main>
<header><h1>${escapeHtml(siteName)}</h1><p>${count}</p></header>
${body}
<footer>Flung with Fling</footer>
</main>
</body>
</html>
`
}
