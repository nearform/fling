import { parseLabel } from '@fling/shared'
import type { Config } from '../config.ts'

/**
 * Open-redirect guard for `?return=`. Allowed: a same-origin path (`/x`, not `//x`), a URL on
 * APP_ORIGIN, or a site (`<name>.`) or share (`s--<token>.`) host under SITES_DOMAIN with
 * SITE_SCHEME (see parseLabel). Anything else
 * becomes `/`. Returns an absolute URL or `/`.
 */
export function safeReturnUrl(
  value: string | undefined | null,
  cfg: Pick<Config, 'appOrigin' | 'sitesDomain' | 'siteScheme'>
): string {
  if (!value) return '/'
  // control characters and backslashes have no business in a return URL
  if ([...value].some(ch => ch < ' ' || ch === '\\')) return '/'
  let url: URL
  try {
    // Relative values resolve against the app; protocol-relative (`//evil`) changes origin and
    // is then rejected by the origin comparison below.
    url = new URL(value, cfg.appOrigin)
  } catch {
    return '/'
  }
  if (url.username || url.password) return '/'
  if (url.origin === cfg.appOrigin) return url.href
  if (url.protocol !== `${cfg.siteScheme}:`) return '/'
  const suffix = `.${cfg.sitesDomain}`
  if (!url.host.endsWith(suffix)) return '/'
  const label = url.host.slice(0, -suffix.length)
  if (!parseLabel(label)) return '/'
  return url.href
}
