/**
 * The site page's Metrics panel, worked out apart from React: who sees it, what it counts, and the
 * bars of its chart. Counts only (@fling/shared/metrics): views where the instance counts them
 * (`viewCounts`), pushes always.
 */
import type { InstanceMetadata, SiteDetail } from '@fling/shared'
import type { SiteMetrics } from '@fling/shared/metrics'

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

/** What the chart draws: views where they are counted, else pushes. */
export const chartedCount = (m: Pick<SiteMetrics, 'viewCounts'>): 'views' | 'pushes' =>
  m.viewCounts ? 'views' : 'pushes'

export interface MetricBar {
  day: string
  count: number
  /** its height, 0–1 of the tallest */
  ratio: number
}

/** The chart's bars, one a day, oldest first, each as tall as its count against the largest. */
export function metricBars(m: Pick<SiteMetrics, 'days'>, key: 'views' | 'pushes'): MetricBar[] {
  const max = Math.max(0, ...m.days.map(d => d[key]))
  return m.days.map(d => ({ day: d.day, count: d[key], ratio: max === 0 ? 0 : d[key] / max }))
}

/** `3 views`, `1 push`. */
export function countLabel(n: number, key: 'views' | 'pushes'): string {
  const one = key === 'views' ? 'view' : 'push'
  return `${n.toLocaleString()} ${n === 1 ? one : key}`
}

/** The chart in words, for screen readers: its range and its busiest day. */
export function chartSummary(bars: readonly MetricBar[], key: 'views' | 'pushes'): string {
  const first = bars[0]
  const last = bars.at(-1)
  if (!first || !last) return ''
  const total = bars.reduce((n, b) => n + b.count, 0)
  const busiest = bars.reduce((top, b) => (b.count > top.count ? b : top), first)
  const range = `${key === 'views' ? 'Views' : 'Pushes'} per day, ${first.day} to ${last.day}: ${countLabel(total, key)}`
  return busiest.count > 0
    ? `${range}, the most on ${busiest.day} (${countLabel(busiest.count, key)}).`
    : `${range}.`
}
