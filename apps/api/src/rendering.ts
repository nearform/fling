/**
 * What a version gets at go-live besides its files, once they have passed the secret scan: pages
 * rendered from them, which the edge serves in their place. Rendered pages are written beside the
 * version's files and never listed in its manifest, so a pull returns what was published.
 *
 *   - Markdown (markdown.ts in shared): every `.md` / `.markdown` file gets a rendered page at
 *     `.rendered/<path>.html` (a dot segment: never a site path), served for the file unless the
 *     request says `?raw=1` (the route's `m`). A folder without an index.html whose Markdown can
 *     stand in (`markdownHomePages`) gets the rendered page as its `index.html` too. At most
 *     MAX_RENDERED_MARKDOWN files of at most MAX_MARKDOWN_BYTES each; the rest are served as
 *     they are.
 *   - The home page of a site with Paths (paths.ts): whether its root index.html has a Paths block
 *     to fill in, or there is no home page at all (`VersionRecord.home`), and its title.
 *
 * Rendering never fails a publish: a file that can't be rendered is served as it is.
 */
import { cacheControlFor, type ManifestFile, siteObjectKey } from '@fling/shared'
import {
  isMarkdownPath,
  MAX_MARKDOWN_BYTES,
  MAX_RENDERED_MARKDOWN,
  markdownHomePages,
  renderedMarkdownKey,
  renderMarkdownPage,
} from '@fling/shared/markdown'
import { hasPathsBlock } from '@fling/shared/paths-index'
import { mapLimit } from './lib/concurrency.ts'
import type { VersionRecord } from './store/types.ts'
import type { Deps } from './types.ts'

const RENDER_CONCURRENCY = 8
/** Home pages are read whole to find a Paths block and a title; bigger ones are left alone. */
const MAX_HOME_BYTES = 1024 * 1024

const HTML = 'text/html; charset=utf-8'
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** The `<title>` of an HTML page, its entities for `&<>"'` decoded; '' without one. */
export function htmlTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!m?.[1]) return ''
  return m[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Render what a version gets at go-live (see the header), writing the pages under its storage
 * prefix (`sites/<storageId>/<versionId>/`). Returns the version's fields that describe them.
 */
export async function renderVersion(
  deps: Deps,
  storageId: string,
  versionId: string,
  files: readonly ManifestFile[]
): Promise<Pick<VersionRecord, 'markdown' | 'home' | 'title'>> {
  const key = (path: string) => siteObjectKey(storageId, versionId, path)
  const markdown = files
    .filter(f => isMarkdownPath(f.path) && f.size <= MAX_MARKDOWN_BYTES)
    .slice(0, MAX_RENDERED_MARKDOWN)
  const homes = markdownHomePages(files.map(f => f.path))
  const homeOf = new Map<string, string[]>()
  for (const [folder, source] of homes) homeOf.set(source, [...(homeOf.get(source) ?? []), folder])

  let rootTitle = ''
  const rendered = await mapLimit(markdown, RENDER_CONCURRENCY, async f => {
    try {
      const bytes = await deps.blobs.get(key(f.path))
      if (!bytes) return false
      const page = renderMarkdownPage(decode(bytes), { path: f.path })
      const body = new TextEncoder().encode(page.html)
      const opts = { contentType: HTML, cacheControl: cacheControlFor(`${f.path}.html`) }
      await deps.blobs.put(key(renderedMarkdownKey(f.path)), body, opts)
      for (const folder of homeOf.get(f.path) ?? []) {
        await deps.blobs.put(key(folder ? `${folder}/index.html` : 'index.html'), body, opts)
        if (folder === '') rootTitle = page.title
      }
      return true
    } catch {
      return false
    }
  })

  const out: Pick<VersionRecord, 'markdown' | 'home' | 'title'> = {}
  if (rendered.some(Boolean)) out.markdown = true
  const index = files.find(f => f.path === 'index.html')
  if (!index) {
    if (homes.has('')) {
      if (rootTitle) out.title = rootTitle
    } else {
      out.home = 'none'
    }
    return out
  }
  if (index.size <= MAX_HOME_BYTES) {
    const bytes = await deps.blobs.get(key('index.html'))
    if (bytes) {
      const html = decode(bytes)
      if (hasPathsBlock(html)) out.home = 'block'
      const title = htmlTitle(html)
      if (title) out.title = title
    }
  }
  return out
}
