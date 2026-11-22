/** Two letters for an avatar fallback. */
export function initials(name: string | null | undefined, email?: string): string {
  const source = name?.trim() || email || '?'
  const parts = source.split(/\s+/).filter(Boolean)
  const letters = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2)
  return letters.toUpperCase()
}

/** "1.4 MB" — binary units, one decimal past KB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** "3 hours ago", "yesterday", "just now". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '—'
  const seconds = Math.round((then - now) / 1000)
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

const DAY_MS = 24 * 60 * 60 * 1000
const utcDay = (t: number) => Math.floor(t / DAY_MS)

/** By UTC day: "today", "yesterday", "3 days ago"; from 30 days, as `timeAgo`. */
export function daysAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return '—'
  const days = Math.max(0, utcDay(now) - utcDay(then))
  return days < 30 ? relative.format(-days, 'day') : timeAgo(iso, now)
}

/** The UTC date alone, for a `title` beside `daysAgo`. */
export function utcDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { timeZone: 'UTC', dateStyle: 'medium' })
}

/** Full local date and time, for a `title` beside a relative time. */
export function fullDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

/** Version ids are long hashes; the first 8 characters are enough to tell them apart. */
export function shortVersion(id: string | null): string {
  return id ? id.slice(0, 8) : '—'
}

/** The URL without its scheme, for display. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}
