/**
 * A day-by-day trend, small (the Sites page's Activity row and each site's in the list): a smooth
 * line with its area faded beneath, today marked. Its shape is against its own busiest day; its
 * colour is that day against `scale`, the busiest day of any of the sites shown together
 * (default: its own), from a faint primary for a quiet site to the brand highlight for the busiest.
 * So each keeps its own shape, and a busy site stands out from a quiet one when the list is
 * scanned. Drawn to fill the box its CSS gives it; it says nothing to screen readers, so its
 * caller does.
 */
import { type CSSProperties, useId } from 'react'
import { pulsePoints, smoothArea, smoothLine } from '../../lib/usage'
import './usage.css'

const W = 100
const H = 24
const PAD = 2

export function DayTrend({
  counts,
  scale,
  className,
}: {
  counts: readonly number[]
  /** the busiest day to colour against; its own by default */
  scale?: number
  className?: string
}) {
  const id = useId()
  const max = Math.max(0, ...counts)
  const top = Math.max(max, scale ?? 0)
  // A square root, so a site with a tenth of the busiest one's views still shows colour.
  const level = top === 0 ? 0 : Math.sqrt(max / top)
  const points = pulsePoints(counts, W, H - PAD * 2).map(p => ({ x: p.x, y: p.y + PAD }))
  const today = points.at(-1)
  return (
    <svg
      className={`day-trend ${className ?? ''}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-quiet={max === 0 ? '' : undefined}
      style={{ '--level': level.toFixed(3) } as CSSProperties}
    >
      <defs>
        <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="day-trend-fade-top" />
          <stop offset="100%" className="day-trend-fade-bottom" />
        </linearGradient>
      </defs>
      <path className="day-trend-area" d={smoothArea(points, H)} fill={`url(#${id}-fade)`} />
      <path className="day-trend-line" d={smoothLine(points)} />
      {today && <circle className="day-trend-today" cx={today.x} cy={today.y} r={1.6} />}
    </svg>
  )
}
