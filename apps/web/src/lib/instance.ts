/**
 * The instance this page belongs to, read at runtime from its metadata (`/.well-known/fling`), so
 * one build serves every instance. The brand becomes the five `--brand-*` inputs theme.css derives
 * its colours from, plus the favicon, `theme-color` and title.
 *
 * What was applied last is cached in localStorage under BRAND_CACHE_KEY; the inline script in
 * index.html / 404.html applies the cached vars before React mounts, so a returning visitor sees
 * no flash of the default theme. Keep that script's checks in step with `brandVars` and
 * `safeAssetUrl` here.
 */
import {
  HEX_COLOR_RE,
  INSTANCE_METADATA_PATH,
  type InstanceBrand,
  type InstanceMetadata,
  InstanceMetadataSchema,
  privateAudience,
} from '@fling/shared'

export const BRAND_CACHE_KEY = 'fling-brand'
export const DEFAULT_INSTANCE_NAME = 'Fling'

/** Brand colour → the theme.css input it sets. */
export const BRAND_VARS = {
  primary: '--brand-primary',
  primaryContent: '--brand-primary-content',
  accent: '--brand-accent',
  ink: '--brand-ink',
  highlight: '--brand-highlight',
} as const

/** The CSS custom properties a brand sets: only known colours, only valid hex. Pure. */
export function brandVars(brand?: Pick<InstanceBrand, 'colors'> | null): Record<string, string> {
  const vars: Record<string, string> = {}
  const colors = (brand?.colors ?? {}) as Record<string, unknown>
  for (const [key, name] of Object.entries(BRAND_VARS)) {
    const value = colors[key]
    if (typeof value === 'string' && HEX_COLOR_RE.test(value)) vars[name] = value
  }
  return vars
}

/** An https:, http: or data:image URL, else undefined (a logo or favicon never runs script). */
export function safeAssetUrl(url: string | undefined): string | undefined {
  return url && /^(https?:\/\/|data:image\/)/i.test(url) ? url : undefined
}

export interface BrandCache {
  vars: Record<string, string>
  name: string
  faviconUrl?: string
  /** the whole document, so the next visit starts from it */
  metadata?: InstanceMetadata
}

export function brandCacheFor(metadata: InstanceMetadata): BrandCache {
  return {
    vars: brandVars(metadata.brand),
    name: metadata.name,
    faviconUrl: safeAssetUrl(metadata.brand.faviconUrl),
    metadata,
  }
}

export function readBrandCache(): BrandCache | null {
  try {
    const raw = localStorage.getItem(BRAND_CACHE_KEY)
    if (!raw) return null
    const cache = JSON.parse(raw) as BrandCache
    const parsed = InstanceMetadataSchema.safeParse(cache.metadata)
    return { ...cache, metadata: parsed.success ? parsed.data : undefined }
  } catch {
    return null
  }
}

/**
 * Apply a brand to the document: the colour inputs (clearing any the brand no longer sets), the
 * favicon, `theme-color` (the ink) and the title, which is `name` or `<titlePrefix> · name`.
 */
export function applyBrand(cache: BrandCache, opts: { titlePrefix?: string } = {}): void {
  const root = document.documentElement
  for (const name of Object.values(BRAND_VARS)) {
    const value = cache.vars[name]
    if (value) root.style.setProperty(name, value)
    else root.style.removeProperty(name)
  }
  if (cache.faviconUrl) {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (icon && icon.href !== cache.faviconUrl) {
      icon.removeAttribute('type')
      icon.href = cache.faviconUrl
    }
  }
  const ink = cache.vars[BRAND_VARS.ink]
  if (ink) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', ink)
  document.title = opts.titlePrefix ? `${opts.titlePrefix} · ${cache.name}` : cache.name
  try {
    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // private mode or full storage: the brand still applies, it just isn't cached
  }
}

/** Fetch and validate the metadata of the instance at `origin` (default: this page's). */
export async function fetchInstance(origin = ''): Promise<InstanceMetadata> {
  const res = await fetch(`${origin}${INSTANCE_METADATA_PATH}`, {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Instance metadata: HTTP ${res.status}`)
  return InstanceMetadataSchema.parse(await res.json())
}

/**
 * The standalone 404's app origin: the `fling-app-origin` meta the deploy fills in, or — when it
 * was never filled (`__APP_ORIGIN__`) — the site host's parent (`https://x.sites.example.test` →
 * `https://sites.example.test`). Pure.
 */
export function notFoundAppOrigin(meta: string | null | undefined, location: Location | URL) {
  const value = meta?.trim()
  if (value && !value.startsWith('__')) {
    try {
      return new URL(value).origin
    } catch {
      // fall through to the host's parent
    }
  }
  const host = location.host
  const dot = host.indexOf('.')
  return `${location.protocol}//${dot > 0 ? host.slice(dot + 1) : host}`
}

/** `npx <package>` when the install command is a plain global npm install, else null. */
export function npxCommandFor(installCommand: string): string | null {
  const m = /^npm (?:i|install) (?:-g|--global) (\S+)$/.exec(installCommand.trim())
  return m ? `npx ${m[1]}` : null
}

/** "anyone signed in to Fling (@example.test accounts)", or generic copy while it loads. */
export function audienceFor(instance: InstanceMetadata | null): string {
  return instance ? privateAudience(instance) : 'anyone signed in to this Fling'
}
