import { describe, expect, it } from 'vitest'
import { lapRoom, roughly, routeRoom, share, shortDuration, size } from '../src/lib/headroom'
import { activityShown } from '../src/lib/usage'

const maintenance = { everyMs: 15 * 60_000, budgetMs: 4 * 60_000 }

describe('headroom', () => {
  it('reads a small store in the unit that shows it', () => {
    expect(size(3977)).toBe('4.0 KB')
    expect(size(512)).toBe('512 bytes')
    expect(size(5_000_000)).toBe('5.00 MB')
    expect(share(3977, 5_000_000)).toBe('under 1%')
    expect(share(0, 5_000_000)).toBe('0%')
  })

  it('says how many more routes fit at their average size', () => {
    const room = routeRoom({ bytes: 3977, limitBytes: 5_000_000, items: 44 })
    expect(room).toMatchObject({ routes: 44, room: 55_274 })
    expect(roughly(room?.room ?? 0)).toBe((55_000).toLocaleString())
    expect(routeRoom({ bytes: 3977, limitBytes: 5_000_000 })).toBeNull()
    expect(routeRoom(null)).toBeNull()
  })

  it("says how many sites one run's sweep gets through at the last lap's pace", () => {
    const lap = { lapMs: 900_000, finishedAt: '', workMs: 2000, runs: 1, sites: 44 }
    expect(lapRoom(lap, maintenance)).toEqual({ sites: 44, workMs: 2000, runs: 1, perRun: 5280 })
    // A lap from before the sweep was timed has nothing to go on.
    expect(lapRoom({ lapMs: 900_000, finishedAt: '' }, maintenance)).toBeNull()
    expect(shortDuration(2000)).toBe('2 seconds')
    expect(shortDuration(30)).toBe('0.1 seconds')
  })
})

describe("the Sites page's activity", () => {
  const caps = (metrics: boolean, viewCounts: boolean) =>
    ({ capabilities: { metrics, viewCounts } }) as unknown as Parameters<typeof activityShown>[0]
  it('shows (and asks for) it only where the instance counts views', () => {
    expect(activityShown(caps(true, true))).toBe(true)
    expect(activityShown(caps(true, false))).toBe(false)
    expect(activityShown(caps(false, false))).toBe(false)
    expect(activityShown(null)).toBe(false)
  })
})
