/**
 * Admin → Routes' headroom: from how full the route store is and how long maintenance's sweep
 * worked at its last lap, how much more the instance takes before either matters. Estimates at
 * today's pace, rounded so they read as estimates.
 */
import type { AdminRouteTable, RouteFormat } from '@fling/shared'

/** A count as an estimate: two significant figures from 100 up ("about 55,000"). */
export function roughly(n: number): string {
  if (n < 100) return Math.floor(n).toLocaleString()
  const step = 10 ** (Math.floor(Math.log10(n)) - 1)
  return (Math.floor(n / step) * step).toLocaleString()
}

/** Bytes in the unit that reads best: 512 bytes, 3.9 KB, 120 KB, 1.25 MB. */
export function size(bytes: number): string {
  if (bytes < 1000) return `${Math.round(bytes)} bytes`
  if (bytes < 1_000_000) {
    const kb = bytes / 1000
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  }
  return `${(bytes / 1_000_000).toFixed(2)} MB`
}

/** A share of a whole: "under 1%" rather than a 0% that reads as nothing. */
export function share(part: number, whole: number): string {
  const p = (part / whole) * 100
  if (p > 0 && p < 1) return 'under 1%'
  return `${Math.round(p)}%`
}

export interface RouteRoom {
  routes: number
  /** what one route takes, on average */
  perRoute: number
  /** how many more routes of that size fit */
  room: number
}

/** Room left in the route store at its routes' average size; null where it doesn't count them. */
export function routeRoom(usage: AdminRouteTable['usage']): RouteRoom | null {
  if (!usage?.items) return null
  const perRoute = usage.bytes / usage.items
  if (perRoute <= 0) return null
  return {
    routes: usage.items,
    perRoute,
    room: Math.max(0, Math.floor((usage.limitBytes - usage.bytes) / perRoute)),
  }
}

/** Compact takes about a third of JSON's space (route-format.ts), so fits about three times as many. */
export const compactFits = (format: RouteFormat) => format === 'json'

export interface LapRoom {
  sites: number
  workMs: number
  runs: number
  /** the most sites one run's sweep gets through at this pace, with nothing else queued */
  perRun: number
}

/** How far the sweep is from needing a second run a lap; null for a lap it didn't time. */
export function lapRoom(
  lap: AdminRouteTable['lastLap'],
  maintenance: AdminRouteTable['maintenance']
): LapRoom | null {
  if (!lap || lap.workMs === undefined || !lap.runs || !lap.sites) return null
  const perSite = Math.max(lap.workMs, 1) / lap.sites
  return {
    sites: lap.sites,
    workMs: lap.workMs,
    runs: lap.runs,
    perRun: Math.floor(maintenance.budgetMs / perSite),
  }
}

/** A short time: "0.4 seconds", "12 seconds", "3 minutes". */
export function shortDuration(ms: number): string {
  const s = ms / 1000
  if (s < 10) return `${Math.max(0.1, Math.round(s * 10) / 10)} seconds`
  if (s < 120) return `${Math.round(s)} seconds`
  return `${Math.round(s / 60)} minutes`
}
