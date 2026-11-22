import { metricRanges, type SiteMetrics } from '@fling/shared/metrics'
import { describe, expect, it } from 'vitest'
import { chartedCount, chartSummary, metricBars, metricsShown } from '../src/lib/metrics'

const on = { capabilities: { metrics: true } }

function metrics(viewCounts: boolean, views: number[] = []): SiteMetrics {
  const { days, weeks, months } = metricRanges(new Date('2026-11-22T12:00:00Z'))
  return {
    name: 'deck',
    viewCounts,
    since: null,
    lastViewAt: null,
    lastPushAt: null,
    days: days.map((day, i) => ({
      day,
      views: views[i] ?? 0,
      pushes: i === days.length - 1 ? 2 : 0,
    })),
    weeks: weeks.map(w => ({ ...w, views: 0, pushes: 0 })),
    months: months.map(month => ({ month, views: 0, pushes: 0 })),
    totals: { days: { views: 0, pushes: 2 }, months: { views: 0, pushes: 2 } },
  }
}

describe('the Metrics panel', () => {
  it('shows for owners, publishers and admins on an instance with metrics, never for others', () => {
    for (const role of ['owner', 'publisher', 'admin'] as const) {
      expect(metricsShown(on, { role }, false)).toBe(true)
    }
    expect(metricsShown(on, { role: undefined }, true)).toBe(true)
    expect(metricsShown(on, { role: undefined }, false)).toBe(false)
    expect(metricsShown({ capabilities: {} }, { role: 'owner' }, true)).toBe(false)
    expect(metricsShown(null, { role: 'owner' }, false)).toBe(false)
  })

  it('charts views where they are counted, pushes where not', () => {
    expect(chartedCount(metrics(true))).toBe('views')
    expect(chartedCount(metrics(false))).toBe('pushes')
  })

  it('draws a bar a day, oldest first, each against the busiest day', () => {
    const bars = metricBars(metrics(true, [2, 8, 0]), 'views')
    expect(bars).toHaveLength(28)
    expect(bars[0]).toMatchObject({ day: '2026-10-26', count: 2, ratio: 0.25 })
    expect(bars[1]?.ratio).toBe(1)
    expect(bars.at(-1)?.day).toBe('2026-11-22')
    expect(metricBars(metrics(true), 'views').every(b => b.ratio === 0)).toBe(true)
  })

  it('says the chart in words', () => {
    const bars = metricBars(metrics(true, [2, 8]), 'views')
    expect(chartSummary(bars, 'views')).toBe(
      'Views per day, 2026-10-26 to 2026-11-22: 10 views, the most on 2026-10-27 (8 views).'
    )
    expect(chartSummary(metricBars(metrics(false), 'pushes'), 'pushes')).toMatch(
      /^Pushes per day, .*: 2 pushes, the most on 2026-11-22 \(2 pushes\)\.$/
    )
  })
})
