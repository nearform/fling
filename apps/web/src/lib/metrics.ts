/**
 * The site page's Metrics panel, worked out apart from React: who sees it, and its counts in
 * words. Counts only (@fling/shared/metrics): views where the instance counts them
 * (`viewCounts`), pushes always.
 */
import type { InstanceMetadata, SiteDetail } from '@fling/shared'

/**
 * Whether the viewer sees the site's metrics: the instance has them, and they are an owner, a
 * publisher or an admin, as the API answers (`site.metrics.read`).
 */
export function metricsShown(
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined,
  site: Pick<SiteDetail, 'role'>,
  admin: boolean
): boolean {
  if (instance?.capabilities.metrics !== true) return false
  return site.role === 'owner' || site.role === 'publisher' || site.role === 'admin' || admin
}

/** `3 views`, `1 push`. */
export function countLabel(n: number, key: 'views' | 'pushes'): string {
  const one = key === 'views' ? 'view' : 'push'
  return `${n.toLocaleString()} ${n === 1 ? one : key}`
}
