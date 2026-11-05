// Starter root index.html pages for a site with Paths (paths-index.ts), for the CLI and the MCP
// servers to offer the same ones. Each is a complete, self-contained page with its Paths block in
// place: neutral styling with no instance's branding, light and dark, readable at any width.
// Browser-safe.

export const PATHS_TEMPLATE_NAMES = ['plans', 'docs', 'reports', 'minimal'] as const
export type PathsTemplateName = (typeof PATHS_TEMPLATE_NAMES)[number]

/** What each template lists, for help text and tool descriptions. */
export const PATHS_TEMPLATE_DESCRIPTIONS: Record<PathsTemplateName, string> = {
  plans: 'a board of plans, one card per ticket folder (e.g. PAY-412), newest first',
  docs: 'a hub of documentation sections, A–Z',
  reports: 'an archive of reports by date, newest first, the date shown first',
  minimal: "a plain page with Fling's default list",
}

const DEFAULT_TITLES: Record<PathsTemplateName, string> = {
  plans: 'Plans',
  docs: 'Docs',
  reports: 'Reports',
  minimal: 'Paths',
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const esc = (value: string) => value.replace(/[&<>"']/g, c => ESCAPES[c] ?? c)

const BASE_CSS = `:root{color-scheme:light dark;--bg:#f7f7f8;--fg:#1c1c21;--muted:#5d5d68;--card:#fff;--line:#e2e2e7;--fling-paths-accent:#2f5fc4}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--fg:#ececf0;--muted:#a0a0ab;--card:#1d1d22;--line:#2e2e35;--fling-paths-accent:#8ab0ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:var(--width,56rem);margin:0 auto;padding:clamp(1.5rem,5vw,3.5rem) 1.25rem}
header{margin-bottom:1.75rem}
h1{font-size:clamp(1.6rem,4vw,2.2rem);letter-spacing:-.015em;margin:0 0 .35rem}
header p{margin:0;color:var(--muted)}
a{color:var(--fling-paths-accent)}
.empty{color:var(--muted);padding:2rem;text-align:center;border:1px dashed var(--line);border-radius:.75rem}`

function page(title: string, intro: string, css: string, body: string): string {
  const t = esc(title)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${t}</title>
<style>
${BASE_CSS}
${css}
</style>
</head>
<body>
<main>
<header>
<h1>${t}</h1>
<p>${intro}</p>
</header>
<!-- fling:paths-controls -->
${body}
</main>
</body>
</html>
`
}

const TEMPLATES: Record<PathsTemplateName, (title: string) => string> = {
  plans: title =>
    page(
      title,
      'One plan per ticket, newest first.',
      `.board{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,16rem),1fr));gap:1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:.75rem;transition:border-color .15s}
.card:hover{border-color:var(--fling-paths-accent)}
.card a{display:flex;flex-direction:column;gap:.4rem;height:100%;padding:1rem 1.1rem;color:inherit;text-decoration:none}
.ticket{align-self:start;font:600 .8rem/1 ui-monospace,monospace;color:var(--fling-paths-accent);background:color-mix(in srgb,var(--fling-paths-accent) 12%,transparent);padding:.3rem .5rem;border-radius:.4rem}
.card h2{font-size:1.05rem;line-height:1.35;margin:0}
.card time{margin-top:auto;font-size:.85rem;color:var(--muted)}`,
      `<div class="board">
<!-- fling:paths sort=updated -->
<article class="card"><a href="{{href}}"><span class="ticket">{{folder}}</span><h2>{{title}}</h2><time datetime="{{updated}}">{{date}}</time></a></article>
<!-- fling:empty -->
<p class="empty">No plans yet. Publish each plan to a folder named after its ticket, such as PAY-412.</p>
<!-- /fling:paths -->
</div>`
    ),
  docs: title =>
    page(
      title,
      'Every section, A–Z.',
      `.sections{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.sections li{border-bottom:1px solid var(--line)}
.sections a{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem 1rem;padding:.9rem .25rem;color:inherit;text-decoration:none}
.sections a:hover .name{color:var(--fling-paths-accent);text-decoration:underline}
.name{font-weight:600;flex:1 1 16rem}
.meta{font-size:.85rem;color:var(--muted)}
.meta code{font-family:ui-monospace,monospace}`,
      `<ul class="sections">
<!-- fling:paths sort=folder -->
<li><a href="{{href}}"><span class="name">{{title}}</span><span class="meta"><code>{{folder}}</code> · updated <time datetime="{{updated}}">{{date}}</time></span></a></li>
<!-- fling:empty -->
<li class="empty">No sections yet. Publish each section to its own folder.</li>
<!-- /fling:paths -->
</ul>`
    ),
  reports: title =>
    page(
      title,
      'Every report, newest first.',
      `.archive{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}
.report{display:grid;grid-template-columns:8.5rem 1fr;align-items:baseline;gap:.25rem 1.25rem;background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1rem 1.1rem}
@media (width < 34rem){.report{grid-template-columns:1fr}}
.report time{font-size:1.15rem;font-weight:700;font-variant-numeric:tabular-nums}
.report a{font-weight:600;text-decoration:none}
.report a:hover{text-decoration:underline}
.report small{grid-column:-2;color:var(--muted);font-family:ui-monospace,monospace}`,
      `<ol class="archive">
<!-- fling:paths sort=updated -->
<li class="report"><time datetime="{{updated}}">{{date}}</time><a href="{{href}}">{{title}}</a><small>{{folder}}</small></li>
<!-- fling:empty -->
<li class="empty">No reports yet. Publish each report to its own folder, such as 2026-11-05.</li>
<!-- /fling:paths -->
</ol>`
    ),
  minimal: title =>
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>
body{max-width:44rem;margin:0 auto;padding:3rem 1.25rem;font:16px/1.5 system-ui,sans-serif}
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<!-- fling:paths -->
</body>
</html>
`,
}

/** A template's index.html, with `title` as its heading when given. */
export function pathsTemplate(name: PathsTemplateName, opts: { title?: string } = {}): string {
  const title = opts.title?.trim() || DEFAULT_TITLES[name]
  return TEMPLATES[name](title)
}

export const isPathsTemplateName = (name: string): name is PathsTemplateName =>
  (PATHS_TEMPLATE_NAMES as readonly string[]).includes(name)
