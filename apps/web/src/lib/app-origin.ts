// The app origin as seen from a sites host, for the pages served there. Dependency-free, so the
// review shell can use it without the instance metadata code.

/**
 * The app origin of a page served on site hosts (the standalone 404, the review shell): the
 * `fling-app-origin` meta the deploy fills in, or — when it was never filled (`__APP_ORIGIN__`) —
 * the site host's parent (`https://x.sites.example.test` → `https://sites.example.test`). Pure.
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
