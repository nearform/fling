/** Helpers for showing a version's file list. */

/** Split a site path into its folder prefix (with trailing slash, or '') and file name. */
export function splitPath(path: string): { folder: string; name: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1
    ? { folder: '', name: path }
    : { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

/** Without a root index.html the site's root URL 404s (SPA fallback serves index.html too). */
export function hasRootIndex(files: readonly { path: string }[]): boolean {
  return files.some(f => f.path === 'index.html')
}

/** The served URL of a file: the site URL plus the path, each segment percent-encoded. */
export function fileUrl(siteUrl: string, path: string): string {
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`
  return base + path.split('/').map(encodeURIComponent).join('/')
}

/**
 * Sort by folder then name, root files first, so each folder's files sit together. (Plain path
 * order would interleave `a/x` between `a.html` and `b.html`.)
 */
export function sortForDisplay<T extends { path: string }>(files: readonly T[]): T[] {
  const key = (p: string) => {
    const { folder, name } = splitPath(p)
    return [folder, name] as const
  }
  return [...files].sort((a, b) => {
    const [fa, na] = key(a.path)
    const [fb, nb] = key(b.path)
    if (fa !== fb) return fa === '' ? -1 : fb === '' ? 1 : fa < fb ? -1 : 1
    return na < nb ? -1 : na > nb ? 1 : 0
  })
}
