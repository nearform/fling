import type { Me } from '@fling/shared'
import { type InstanceUsage, metricRanges } from '@fling/shared/metrics'
import { describe, expect, it } from 'vitest'
import { ADMIN_USAGE_TAB, adminTabsFor } from '../src/components/AdminTabs'
import {
  funnel,
  funnelSummary,
  gatheringDust,
  heatLevel,
  heatmapWeeks,
  idleFor,
  isQuiet,
  lapNotice,
  leaderboard,
  monthBars,
  peakIndex,
  percent,
  pulseCount,
  pulsePoints,
  pulseSummary,
  showsLastViewed,
  showsUsageAdmin,
  smoothArea,
  smoothLine,
} from '../src/lib/usage'

const NOW = new Date('2026-11-22T12:00:00Z')

function usage(over: Partial<InstanceUsage> = {}, views: number[] = []): InstanceUsage {
  const { days, weeks, months } = metricRanges(NOW)
  return {
    viewCounts: true,
    sweep: true,
    days: days.map((day, i) => ({ day, views: views[i] ?? 0, pushes: 0 })),
    weeks: weeks.map(w => ({ ...w, views: 0, pushes: 0 })),
    months: months.map(month => ({ month, views: 0, pushes: 0 })),
    totals: { days: { views: 0, pushes: 0 }, months: { views: 0, pushes: 0 } },
    lap: null,
    ...over,
  }
}

const lap = (over: Partial<NonNullable<InstanceUsage['lap']>> = {}) => ({
  sites: 12,
  live: 10,
  viewed: { days7: 2, days28: 5, days90: 8 },
  neverViewed: 1,
  top: [],
  idle: [],
  lapStartedAt: '2026-11-22T10:00:00Z',
  finishedAt: '2026-11-22T11:00:00Z',
  ...over,
})

const admin = { admin: true, impersonator: null } as unknown as Me

describe('Admin → Usage', () => {
  it('is offered to admins on an instance with metrics, never otherwise', () => {
    const on = { capabilities: { metrics: true } }
    expect(showsUsageAdmin(admin, on)).toBe(true)
    expect(showsUsageAdmin(admin, { capabilities: {} })).toBe(false)
    expect(showsUsageAdmin({ ...admin, admin: false }, on)).toBe(false)
    expect(showsUsageAdmin({ ...admin, impersonator: 'boss@example.test' }, on)).toBe(false)
    expect(adminTabsFor(false, false, true)).toContain(ADMIN_USAGE_TAB)
    expect(adminTabsFor(false, false, false)).not.toContain(ADMIN_USAGE_TAB)
  })

  it('shows All sites’ Last viewed only where views are counted', () => {
    expect(showsLastViewed({ capabilities: { metrics: true, viewCounts: true } })).toBe(true)
    expect(showsLastViewed({ capabilities: { metrics: true } })).toBe(false)
    expect(showsLastViewed({ capabilities: { viewCounts: true } })).toBe(false)
    expect(showsLastViewed(null)).toBe(false)
  })

  it('charts views where they are counted, pushes where not', () => {
    expect(pulseCount(usage())).toBe('views')
    expect(pulseCount(usage({ viewCounts: false }))).toBe('pushes')
  })

  it('flags the busiest day, the latest of a tie, and none when nothing happened', () => {
    expect(peakIndex(usage({}, [1, 5, 2, 5]).days, 'views')).toBe(3)
    expect(peakIndex(usage().days, 'views')).toBeNull()
  })

  it('draws a curve that never strays outside the chart, flat on the floor when all is quiet', () => {
    const points = pulsePoints([0, 10, 0, 3, 3, 10], 100, 50)
    expect(points[0]).toEqual({ x: 0, y: 50 })
    expect(points[1]).toEqual({ x: 20, y: 0 })
    const ys = [...smoothLine(points).matchAll(/-?\d+(\.\d+)?,(-?\d+(\.\d+)?)/g)].map(m =>
      Number(m[2])
    )
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...ys)).toBeLessThanOrEqual(50)
    expect(pulsePoints([0, 0, 0], 100, 50).every(p => p.y === 50)).toBe(true)
    expect(smoothArea(points, 50)).toMatch(/L100,50L0,50Z$/)
    expect(smoothLine([])).toBe('')
  })

  it('says the pulse in words', () => {
    expect(pulseSummary(usage({}, [2, 8]))).toBe(
      'Views per day across every site, Mon 26 Oct to Sun 22 Nov: 10 views, the most on Tue 27 Oct (8 views), and 0 pushes.'
    )
    expect(pulseSummary(usage({ viewCounts: false }))).toBe(
      'Pushes per day across every site, Mon 26 Oct to Sun 22 Nov: 0 pushes.'
    )
  })

  it('warms the calendar in quarters of the busiest day', () => {
    expect(heatLevel(0, 10)).toBe(0)
    expect(heatLevel(1, 10)).toBe(1)
    expect(heatLevel(5, 10)).toBe(2)
    expect(heatLevel(7, 10)).toBe(3)
    expect(heatLevel(10, 10)).toBe(4)
    expect(heatLevel(0, 0)).toBe(0)
  })

  it('lays the calendar out a week a column, Monday at the top', () => {
    const weeks = heatmapWeeks(usage({}, [4]).days, 'views')
    // 26 Oct 2026 is a Monday; 28 days end on Sunday 22 Nov: four whole weeks.
    expect(weeks).toHaveLength(4)
    expect(weeks.every(w => w.length === 7)).toBe(true)
    expect(weeks[0]?.[0]).toEqual({ day: '2026-10-26', count: 4, level: 4 })
    expect(weeks[3]?.[6]?.day).toBe('2026-11-22')
    const { days } = metricRanges(new Date('2026-11-25T12:00:00Z'))
    const offset = heatmapWeeks(
      days.map(day => ({ day, views: 0, pushes: 0 })),
      'views'
    )
    // From Thursday 29 Oct to Wednesday 25 Nov: blanks before and after.
    expect(offset).toHaveLength(5)
    expect(offset[0]?.slice(0, 3)).toEqual([null, null, null])
    expect(offset[4]?.slice(3)).toEqual([null, null, null, null])
  })

  it('measures each month against the busiest', () => {
    const u = usage()
    u.months = u.months.map((m, i) => ({ ...m, views: i === 11 ? 20 : i === 10 ? 5 : 0 }))
    const bars = monthBars(u.months, 'views')
    expect(bars.at(-1)?.ratio).toBe(1)
    expect(bars.at(-2)?.ratio).toBe(0.25)
    expect(monthBars(usage().months, 'views').every(b => b.ratio === 0)).toBe(true)
  })

  it('rings the live sites by how lately they were viewed, widest window outermost', () => {
    const f = funnel(lap())
    expect(f.rings.map(r => [r.key, r.count, r.share])).toEqual([
      ['days90', 8, 0.8],
      ['days28', 5, 0.5],
      ['days7', 2, 0.2],
    ])
    expect(f.neverViewed).toEqual({ count: 1, share: 0.1 })
    expect(funnelSummary(f)).toBe(
      'Of 10 sites live: 8 sites (80%) viewed in 90 days, 5 sites (50%) viewed in 28 days, 2 sites (20%) viewed in 7 days; 1 site never viewed.'
    )
    const none = funnel(
      lap({ live: 0, viewed: { days7: 0, days28: 0, days90: 0 }, neverViewed: 0 })
    )
    expect(none.rings.every(r => r.share === 0)).toBe(true)
    expect(funnelSummary(none)).toBe('No live sites yet.')
  })

  it('never rounds a share above nothing down to 0%', () => {
    expect(percent(0)).toBe('0%')
    expect(percent(0.001)).toBe('<1%')
    expect(percent(0.456)).toBe('46%')
  })

  it('ranks the most viewed against the first, three on the podium', () => {
    const board = leaderboard([
      { name: 'a', views: 40 },
      { name: 'b', views: 20 },
      { name: 'c', views: 10 },
      { name: 'd', views: 1 },
    ])
    expect(board.map(s => [s.rank, s.ratio, s.podium])).toEqual([
      [1, 1, true],
      [2, 0.5, true],
      [3, 0.25, true],
      [4, 0.025, false],
    ])
    expect(leaderboard([])).toEqual([])
  })

  it('says how long a site has gone unused, and gathers more dust the longer', () => {
    expect(idleFor(0.5)).toBe('under a day')
    expect(idleFor(1)).toBe('1 day')
    expect(idleFor(13)).toBe('13 days')
    expect(idleFor(20)).toBe('2 weeks')
    expect(idleFor(125)).toBe('4 months')
    expect(idleFor(800)).toBe('2 years')
    const dust = gatheringDust(
      [
        { name: 'old', lastActiveAt: '2024-11-01T00:00:00Z' },
        { name: 'months', lastActiveAt: '2026-07-22T12:00:00Z' },
        { name: 'week', lastActiveAt: '2026-11-15T00:00:00Z' },
        { name: 'fresh', lastActiveAt: '2026-11-22T12:00:00Z' },
      ],
      NOW.getTime()
    )
    // A site used in the last week isn't gathering dust, however few sites there are.
    expect(dust.map(s => s.idleFor)).toEqual(['2 years', '4 months', '7 days'])
    expect(dust[0]?.dust).toBe(1)
    expect(dust[1]?.dust).toBeGreaterThan(0.5)
    expect(dust[1]?.dust).toBeLessThan(1)
  })

  it('explains where the site tallies are missing or incomplete', () => {
    expect(lapNotice(usage())?.text).toMatch(/hasn’t been round every site yet/)
    expect(lapNotice(usage({ sweep: false }))).toMatchObject({ tone: 'empty' })
    expect(lapNotice(usage({ sweep: false }))?.text).toMatch(/sweep .* is off/)
    expect(lapNotice(usage({ sweep: false, lap: lap() }))).toMatchObject({ tone: 'info' })
    expect(lapNotice(usage({ lap: lap({ partial: true }) }))?.text).toMatch(
      /some sites are missing/
    )
    expect(lapNotice(usage({ lap: lap() }))).toBeNull()
  })

  it('knows a brand-new instance is quiet', () => {
    expect(isQuiet(usage())).toBe(true)
    expect(
      isQuiet(usage({ totals: { days: { views: 0, pushes: 0 }, months: { views: 0, pushes: 1 } } }))
    ).toBe(false)
  })
})
