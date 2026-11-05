/**
 * The Guide: the user guide every instance serves at `/guide`, written once as Markdown pages in
 * `apps/web/content/guide/<part>/<page>.md` and shown with the instance's own address, name and
 * features. This module is the pages' contract: their frontmatter, the parts that order the nav,
 * their addresses, and the placeholders a page writes instead of anything instance-specific.
 *
 * Pure and browser-safe. The web app renders the pages; `scripts/docs-stale.mjs` reads the same
 * frontmatter to say which pages describe code that changed since someone last checked them.
 */
import { z } from 'zod'

/** The guide's parts, in nav order. A page's `part` is the directory it lives in. */
export const GUIDE_PARTS = [
  { id: 'start', label: 'Start' },
  { id: 'publish', label: 'Publish' },
  { id: 'share', label: 'Share' },
  { id: 'team-sites', label: 'Team sites' },
  { id: 'feedback', label: 'Feedback' },
  { id: 'admin', label: 'Admin' },
  { id: 'run', label: 'Run your own Fling' },
] as const

export type GuidePartId = (typeof GUIDE_PARTS)[number]['id']
const PART_IDS = GUIDE_PARTS.map(p => p.id) as [GuidePartId, ...GuidePartId[]]

/** Where the guide lives in the web app. */
export const GUIDE_ROUTE = '/guide'

export const GuideFrontmatterSchema = z.object({
  title: z.string().min(1),
  part: z.enum(PART_IDS),
  /** its place within the part */
  order: z.number().int(),
  /** one line: the nav's tooltip and what search matches besides the text */
  summary: z.string().min(1),
  /** capabilities the page needs; it is hidden on an instance without any of them */
  requires: z.array(z.string().min(1)).default([]),
  /** `admin`: shown to the instance's admins only */
  audience: z.enum(['everyone', 'admin']).default('everyone'),
  /** repository globs of the code the page describes (coarse: a directory, not a list of files) */
  sources: z.array(z.string().min(1)).min(1),
  /** the commit at which the page was last checked against its sources */
  verified: z.string().regex(/^[0-9a-f]{7,40}$/, 'a commit sha'),
})
export type GuideFrontmatter = z.infer<typeof GuideFrontmatterSchema>

export interface GuidePage {
  /** `start/connect`: the page's address under GUIDE_ROUTE, and its file without `.md` */
  slug: string
  meta: GuideFrontmatter
  /** the Markdown after the frontmatter, placeholders unresolved */
  body: string
}

/** Files under the content directory that are pages: not `VOICE.md`, not under a `_` directory. */
export function isGuidePagePath(path: string): boolean {
  if (!path.endsWith('.md')) return false
  const parts = path.split('/')
  return parts.length === 2 && !parts.some(p => p.startsWith('_'))
}

/** A page's file (relative to the content directory) → its slug. */
export const guideSlugOf = (path: string): string => path.replace(/\.md$/, '')

/** The address of a page, or of the guide itself. */
export const guideHref = (slug?: string, anchor?: string): string =>
  `${GUIDE_ROUTE}${slug ? `/${slug}` : ''}${anchor ? `#${anchor}` : ''}`

/** The guide of an instance that has one (`https://fling.example.test/guide`), else undefined. */
export const instanceGuideUrl = (
  instance: { appOrigin?: string; capabilities?: Record<string, boolean> } | null | undefined
): string | undefined =>
  instance?.appOrigin && instance.capabilities?.guide === true
    ? `${instance.appOrigin}${GUIDE_ROUTE}`
    : undefined

/** A slug the platforms can serve as a deep link: lower case, no dots (a dot reads as a file). */
export const GUIDE_SLUG_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/

/**
 * The frontmatter block: `key: value` lines between `---` fences. Values are a number, a
 * `[a, b]` list, or a string (quotes optional). Enough YAML for the guide, and no YAML dependency.
 */
export function splitFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!match) throw new Error('no frontmatter (a --- block at the top)')
  const data: Record<string, unknown> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) throw new Error(`frontmatter line not understood: ${line}`)
    const [, key, rawValue = ''] = kv
    data[key as string] = parseValue(rawValue.replace(/\s+#.*$/, '').trim())
  }
  return { data, body: raw.slice(match[0].length) }
}

const unquote = (v: string): string => v.replace(/^(['"])(.*)\1$/, '$2')

function parseValue(value: string): unknown {
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    return inner ? inner.split(',').map(v => unquote(v.trim())) : []
  }
  if (/^-?\d+$/.test(value)) return Number(value)
  return unquote(value)
}

/** One page from its file: `path` relative to the content directory, `raw` its text. */
export function parseGuidePage(path: string, raw: string): GuidePage {
  const { data, body } = splitFrontmatter(raw)
  const parsed = GuideFrontmatterSchema.safeParse(data)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`${path}: ${issues}`)
  }
  const slug = guideSlugOf(path)
  if (slug.split('/')[0] !== parsed.data.part) {
    throw new Error(`${path}: part "${parsed.data.part}" but it lives in ${slug.split('/')[0]}/`)
  }
  return { slug, meta: parsed.data, body }
}

const partIndex = (part: GuidePartId) => PART_IDS.indexOf(part)

/** Nav order: by part, then `order`, then slug. */
export const compareGuidePages = (a: GuidePage, b: GuidePage): number =>
  partIndex(a.meta.part) - partIndex(b.meta.part) ||
  a.meta.order - b.meta.order ||
  a.slug.localeCompare(b.slug)

/** Who is reading: the instance's capabilities, and whether they are one of its admins. */
export interface GuideReader {
  capabilities: Record<string, boolean>
  admin: boolean
}

const hasAll = (reader: GuideReader, requires: readonly string[]) =>
  requires.every(c => reader.capabilities[c] === true)

/** Whether `reader` sees the page: the instance has what it needs, and admin pages for admins. */
export const guidePageVisible = (page: GuidePage, reader: GuideReader): boolean =>
  hasAll(reader, page.meta.requires) && (page.meta.audience !== 'admin' || reader.admin)

/**
 * `{{instance:origin}}`, `{{instance:site:my-app}}`, `{{fact:max-deploy}}`: what a page writes
 * in place of anything that differs by instance or that the code owns.
 */
export const GUIDE_PLACEHOLDER_RE = /\{\{\s*(instance|fact):([a-z0-9-]+)(?::([a-z0-9-]+))?\s*\}\}/g

/** `<!-- requires: forms -->…<!-- /requires -->`: a passage only for instances with `forms`. */
export const GUIDE_REQUIRES_RE =
  /<!--\s*requires:\s*([a-zA-Z0-9, ]+?)\s*-->([\s\S]*?)<!--\s*\/requires\s*-->/g

/** The instance values a page may name (`{{instance:<key>}}`). */
export const GUIDE_INSTANCE_KEYS = [
  /** the instance's address: `https://fling.example.com` */
  'origin',
  /** its name, as its brand says it */
  'name',
  /** the remote MCP connector's URL */
  'mcp',
  /** the command that installs the CLI */
  'install',
  /** the sites' domain: `sites.example.com` */
  'sites',
  /** the account people sign in with: "your Example account" */
  'account',
  /** who a private site is open to: "anyone signed in to Fling (@example.com accounts)" */
  'audience',
  /** a site's URL: `{{instance:site:my-app}}` */
  'site',
] as const
export type GuideInstanceKey = (typeof GUIDE_INSTANCE_KEYS)[number]

export interface GuideContext {
  /** every key but `site`, already worked out */
  instance: Record<Exclude<GuideInstanceKey, 'site'>, string>
  /** `site:<name>` → its URL */
  siteUrl: (name: string) => string
  facts: Readonly<Record<string, string>>
  reader: GuideReader
}

/**
 * A page's Markdown for one instance and reader: passages for features it lacks dropped,
 * placeholders filled in. `unknown` lists the placeholders nothing fills (the tests keep it empty);
 * they are left in the text as written.
 */
export function resolveGuideText(
  body: string,
  ctx: GuideContext
): { text: string; unknown: string[] } {
  const unknown: string[] = []
  const kept = body.replace(GUIDE_REQUIRES_RE, (_all, list: string, inner: string) =>
    hasAll(
      ctx.reader,
      list
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    )
      ? inner
      : ''
  )
  const text = kept.replace(
    GUIDE_PLACEHOLDER_RE,
    (all, kind: string, key: string, arg?: string) => {
      if (kind === 'fact') {
        const fact = ctx.facts[key]
        if (fact === undefined || arg) unknown.push(all)
        return fact ?? all
      }
      if (key === 'site') {
        if (!arg) unknown.push(all)
        return arg ? ctx.siteUrl(arg) : all
      }
      const value = (ctx.instance as Record<string, string>)[key]
      if (value === undefined || arg) unknown.push(all)
      return value ?? all
    }
  )
  return { text, unknown }
}
