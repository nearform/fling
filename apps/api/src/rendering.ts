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
 *   - View counts (view counting on, views.ts): every HTML page the version serves (its `.html`
 *     and `.htm` files, and the Markdown home pages written in a folder's index.html) gets a copy
 *     with the view beacon at `.counted/<path>` (COUNTED_DIR), served in its place while the route
 *     says `c`, and the rendered Markdown pages carry the beacon themselves. All or nothing:
 *     the edge serves a copy for every page or for none, so a version with more than
 *     MAX_COUNTED_PAGES pages, or one bigger than MAX_COUNTED_BYTES, or a copy that fails to
 *     write, leaves the version uncounted (`VersionRecord.counted` unset). View counting's rollout
 *     renders a live version again, with or without the beacon, when an admin turns it on or off.
 *
 * Rendering never fails a publish: a file that can't be rendered is served as it is.
 */
import { cacheControlFor, type ManifestFile, siteObjectKey } from '@fling/shared'
import { markdownHomePages, markdownPages, renderMarkdownPage } from '@fling/shared/markdown'
import { hasPathsBlock } from '@fling/shared/paths-index'
import { COUNTED_DIR, FLING_DIR } from '@fling/shared/route-keys'
import { withViewBeacon } from '@fling/shared/view-beacon'
import { mapLimit } from './lib/concurrency.ts'
import type { VersionRecord } from './store/types.ts'
import type { Deps } from './types.ts'
import { viewCountingOn } from './views.ts'

const RENDER_CONCURRENCY = 8
/** Home pages are read whole to find a Paths block and a title; bigger ones are left alone. */
const MAX_HOME_BYTES = 1024 * 1024

/** The most HTML pages a version can have and count views, and the largest such page. */
export const MAX_COUNTED_PAGES = 2000
export const MAX_COUNTED_BYTES = 5 * 1024 * 1024

const HTML = 'text/html; charset=utf-8'
const isHtmlPath = (path: string) => /\.html?$/i.test(path)
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
  files: readonly ManifestFile[],
  /** whether its pages count views: view counting as it is now, unless given */
  opts: { counting?: boolean } = {}
): Promise<Pick<VersionRecord, 'markdown' | 'home' | 'title' | 'counted'>> {
  const key = (path: string) => siteObjectKey(storageId, versionId, path)
  const homes = markdownHomePages(files.map(f => f.path))
  const pages = files.filter(f => isHtmlPath(f.path) && !`/${f.path}`.startsWith(FLING_DIR))
  const counting =
    (opts.counting ?? (await viewCountingOn(deps))) &&
    pages.length <= MAX_COUNTED_PAGES &&
    pages.every(f => f.size <= MAX_COUNTED_BYTES)
  let rootTitle = ''
  const rendered = await mapLimit(markdownPages(files), RENDER_CONCURRENCY, async f => {
    try {
      const bytes = await deps.blobs.get(key(f.path))
      if (!bytes) return { done: false, copied: true }
      const page = renderMarkdownPage(decode(bytes), { path: f.path })
      const html = counting ? withViewBeacon(page.html) : page.html
      const body = new TextEncoder().encode(html)
      const opts = { contentType: HTML, cacheControl: cacheControlFor(`${f.path}.html`) }
      let copied = true
      for (const k of f.keys) {
        await deps.blobs.put(key(k), body, opts)
        if (k === 'index.html') rootTitle = page.title
        // A folder's Markdown home page is served as an HTML page: it needs its copy too.
        if (counting && isHtmlPath(k) && !k.startsWith('.rendered/')) {
          copied = (await unless(deps.blobs.put(key(`${COUNTED_DIR}${k}`), body, opts))) && copied
        }
      }
      return { done: true, copied }
    } catch {
      return { done: false, copied: false }
    }
  })
  const copied =
    counting &&
    rendered.every(r => r.copied) &&
    (await mapLimit(pages, RENDER_CONCURRENCY, f => countedCopy(deps, key, f.path))).every(Boolean)

  const out: Pick<VersionRecord, 'markdown' | 'home' | 'title' | 'counted'> = {}
  if (rendered.some(r => r.done)) out.markdown = true
  if (copied) out.counted = true
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

/** Whether `write` succeeded. */
async function unless(write: Promise<unknown>): Promise<boolean> {
  try {
    await write
    return true
  } catch {
    return false
  }
}

/** Write `path`'s copy with the view beacon (`.counted/<path>`); whether it was written. */
async function countedCopy(
  deps: Deps,
  key: (path: string) => string,
  path: string
): Promise<boolean> {
  try {
    const bytes = await deps.blobs.get(key(path))
    if (!bytes) return false
    const body = new TextEncoder().encode(withViewBeacon(decode(bytes)))
    await deps.blobs.put(key(`${COUNTED_DIR}${path}`), body, {
      contentType: HTML,
      cacheControl: cacheControlFor(path),
    })
    return true
  } catch {
    return false
  }
}
