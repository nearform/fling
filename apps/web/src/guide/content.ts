/**
 * The Guide's pages, bundled into the app at build time (`content/guide/<part>/<page>.md`), so an
 * instance serves the guide of its own release with no request. Parsing a page that breaks the
 * frontmatter contract throws here, and so fails the build and the tests rather than a reader.
 */
import { compareGuidePages, type GuidePage, isGuidePagePath, parseGuidePage } from '@fling/shared'

const files = import.meta.glob('../../content/guide/*/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const PREFIX = '../../content/guide/'

/** Every page, in nav order. */
export const GUIDE_PAGES: readonly GuidePage[] = Object.entries(files)
  .map(([file, raw]) => [file.slice(PREFIX.length), raw] as const)
  .filter(([path]) => isGuidePagePath(path))
  .map(([path, raw]) => parseGuidePage(path, raw))
  .sort(compareGuidePages)
