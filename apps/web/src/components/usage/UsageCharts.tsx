/**
 * Admin → Usage's charts, drawn in inline SVG and CSS from the brand's colours (usage.css): the
 * pulse of the last 28 days, the calendar of them, the 12-month strip, the activity rings, the
 * most viewed and the sites gathering dust. Each says what it shows in words for screen readers,
 * and every number it draws is in a hover or focus readout or in the page's table of numbers.
 * The shapes come from lib/usage.ts; only drawing happens here.
 */

import type { InstanceUsage, UsageTally } from '@fling/shared/metrics'
import { EyeSlashIcon } from '@heroicons/react/24/outline'
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { Link } from 'react-router-dom'
import { fullDate } from '../../lib/format'
import { countLabel } from '../../lib/metrics'
import { siteHref } from '../../lib/sites'
import {
  DUST_AFTER_DAYS,
  dayLabel,
  dayReadout,
  funnel,
  funnelSummary,
  gatheringDust,
  heatmapWeeks,
  leaderboard,
  monthBars,
  monthLabel,
  peakIndex,
  percent,
  pulseCount,
  pulsePoints,
  pulseSummary,
  smoothArea,
  smoothLine,
} from '../../lib/usage'

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** A number that counts up from 0 when it first shows (at once with reduced motion). */
export function CountUp({ value, ms = 900 }: { value: number; ms?: number }) {
  const [shown, setShown] = useState(() => (reducedMotion() ? value : 0))
  useEffect(() => {
    if (reducedMotion() || value === 0) {
      setShown(value)
      return
    }
    let frame = 0
    const start = performance.now()
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms)
      setShown(Math.round(value * (1 - (1 - p) ** 3)))
      if (p < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value, ms])
  return (
    <>
      <span aria-hidden="true">{shown.toLocaleString()}</span>
      <span className="sr-only">{value.toLocaleString()}</span>
    </>
  )
}

const W = 600
const CHART_H = 150
const TOP = 16
const SPARK_Y = TOP + CHART_H + 14
const H = SPARK_Y + 10

/**
 * The last 28 days across every site: views (or pushes, where views aren't counted) as a smooth
 * area, the busiest day flagged, pushes as sparks along the bottom. Pointer or arrow keys pick a
 * day; its readout floats over it.
 */
export function Pulse({ usage }: { usage: InstanceUsage }) {
  const id = useId()
  const key = pulseCount(usage)
  const days = usage.days
  const points = pulsePoints(
    days.map(d => d[key]),
    W,
    CHART_H
  ).map(p => ({ x: p.x, y: p.y + TOP }))
  const peak = peakIndex(days, key)
  const [picked, setPicked] = useState<number | null>(null)
  const plot = useRef<HTMLDivElement>(null)
  const maxPushes = Math.max(0, ...days.map(d => d.pushes))
  const last = days.length - 1

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const box = plot.current?.getBoundingClientRect()
    if (!box || box.width === 0) return
    const at = Math.round(((e.clientX - box.left) / box.width) * last)
    setPicked(Math.max(0, Math.min(last, at)))
  }
  const step = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = picked ?? peak ?? last
    const to =
      e.key === 'ArrowLeft' || e.key === 'ArrowDown'
        ? from - 1
        : e.key === 'ArrowRight' || e.key === 'ArrowUp'
          ? from + 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : null
    if (to === null) return
    e.preventDefault()
    setPicked(Math.max(0, Math.min(last, to)))
  }

  const shown = picked ?? peak
  const day = shown === null ? undefined : days[shown]
  const point = shown === null ? undefined : points[shown]
  const summary = pulseSummary(usage)

  return (
    <figure className="usage-pulse">
      <div
        ref={plot}
        className="usage-pulse-plot"
        data-quiet={peak === null ? '' : undefined}
        tabIndex={0}
        role="slider"
        aria-label={`${key === 'views' ? 'Views' : 'Pushes'} per day: use the arrow keys to read each day`}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={shown ?? last}
        aria-valuetext={day ? dayReadout(day, usage.viewCounts) : summary}
        aria-describedby={`${id}-summary`}
        onPointerMove={pick}
        onPointerLeave={() => setPicked(null)}
        onKeyDown={step}
        onBlur={() => setPicked(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
          <defs>
            <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="usage-pulse-stop-top" />
              <stop offset="100%" className="usage-pulse-stop-bottom" />
            </linearGradient>
          </defs>
          {[0, 0.5, 1].map(f => (
            <line
              key={f}
              className="usage-pulse-grid"
              x1={0}
              x2={W}
              y1={TOP + CHART_H * f}
              y2={TOP + CHART_H * f}
            />
          ))}
          <path
            className="usage-pulse-area"
            d={smoothArea(points, TOP + CHART_H)}
            fill={`url(#${id}-fill)`}
          />
          <path className="usage-pulse-line" d={smoothLine(points)} pathLength={1} />
          {key === 'views' &&
            days.map((d, i) =>
              d.pushes > 0 ? (
                <circle
                  key={d.day}
                  className="usage-pulse-spark"
                  cx={points[i]?.x}
                  cy={SPARK_Y}
                  r={2.5 + 4 * Math.sqrt(d.pushes / maxPushes)}
                  style={{ '--i': i } as CSSProperties}
                >
                  <title>{`${dayLabel(d.day)}: ${countLabel(d.pushes, 'pushes')}`}</title>
                </circle>
              ) : null
            )}
          {point && shown !== peak && (
            <line
              className="usage-pulse-cursor"
              x1={point.x}
              x2={point.x}
              y1={TOP}
              y2={TOP + CHART_H}
            />
          )}
          {peak !== null && points[peak] && (
            <circle className="usage-pulse-peak" cx={points[peak]?.x} cy={points[peak]?.y} r={6} />
          )}
          {point && shown !== peak && (
            <circle className="usage-pulse-dot" cx={point.x} cy={point.y} r={5} />
          )}
        </svg>
        {day && point && (
          <div
            className="usage-pulse-tip"
            data-peak={shown === peak ? '' : undefined}
            data-below={point.y < H * 0.45 ? '' : undefined}
            data-edge={point.x < W * 0.15 ? 'start' : point.x > W * 0.85 ? 'end' : undefined}
            style={{ '--x': point.x / W, '--y': point.y / H } as CSSProperties}
            aria-hidden="true"
          >
            {shown === peak && picked === null && (
              <span className="usage-pulse-tip-flag">Busiest day</span>
            )}
            <strong className="tabular-nums">{countLabel(day[key], key)}</strong>
            <span>{dayLabel(day.day)}</span>
            {key === 'views' && day.pushes > 0 && (
              <span className="tabular-nums">{countLabel(day.pushes, 'pushes')}</span>
            )}
          </div>
        )}
      </div>
      <figcaption className="usage-axis text-xs text-muted tabular-nums">
        <span>{days[0] && dayLabel(days[0].day)}</span>
        <span className="usage-legend">
          <span className="usage-key usage-key-line" aria-hidden="true" />
          {key === 'views' ? 'Views' : 'Pushes'} per day
          {key === 'views' && (
            <>
              <span className="usage-key usage-key-spark" aria-hidden="true" />
              Pushes
            </>
          )}
        </span>
        <span>Today</span>
      </figcaption>
      <p id={`${id}-summary`} className="sr-only">
        {summary}
      </p>
    </figure>
  )
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** The 28 days as a calendar, a column a week, each day as warm as it was busy. */
export function Heatmap({ usage }: { usage: InstanceUsage }) {
  const key = pulseCount(usage)
  const weeks = heatmapWeeks(usage.days, key)
  return (
    <figure className="usage-heatmap">
      <div className="usage-heatmap-grid" role="img" aria-label={pulseSummary(usage)}>
        {WEEKDAYS.map((d, i) => (
          <span key={d} className="usage-heatmap-weekday" style={{ gridRow: i + 1 }}>
            {i % 2 === 0 ? d : ''}
          </span>
        ))}
        {weeks.flatMap((week, w) =>
          week.map((cell, d) =>
            cell ? (
              <span
                key={cell.day}
                className="usage-heat-cell"
                data-level={cell.level}
                style={{ gridColumn: w + 2, gridRow: d + 1, '--i': w * 7 + d } as CSSProperties}
                title={`${dayLabel(cell.day)}: ${countLabel(cell.count, key)}`}
              />
            ) : (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: a blank cell is only its place
                key={`blank-${w}-${d}`}
                className="usage-heat-blank"
                style={{ gridColumn: w + 2, gridRow: d + 1 }}
              />
            )
          )
        )}
      </div>
      <figcaption className="usage-heatmap-scale text-xs text-muted" aria-hidden="true">
        Less
        {[0, 1, 2, 3, 4].map(l => (
          <span key={l} className="usage-heat-cell" data-level={l} />
        ))}
        More
      </figcaption>
    </figure>
  )
}

/** The 12 months as a strip of bars, this one last. */
export function MonthStrip({ usage }: { usage: InstanceUsage }) {
  const key = pulseCount(usage)
  const bars = monthBars(usage.months, key)
  const total = usage.totals.months[key]
  const busiest = bars.reduce((top, b) => (b.count > (top?.count ?? 0) ? b : top), bars[0])
  const summary = `${key === 'views' ? 'Views' : 'Pushes'} per month over ${bars.length} months: ${countLabel(total, key)}${busiest && busiest.count > 0 ? `, the most in ${monthLabel(busiest.month)} (${countLabel(busiest.count, key)})` : ''}.`
  return (
    <figure className="usage-months">
      <div className="usage-months-bars" role="img" aria-label={summary}>
        {bars.map((b, i) => (
          <span
            key={b.month}
            className="usage-month"
            data-empty={b.count === 0 ? '' : undefined}
            data-current={i === bars.length - 1 ? '' : undefined}
            style={{ '--h': b.ratio, '--i': i } as CSSProperties}
            title={`${monthLabel(b.month)}: ${countLabel(b.count, key)}`}
          />
        ))}
      </div>
      <figcaption className="usage-months-labels text-xs text-muted" aria-hidden="true">
        {bars.map(b => (
          <span key={b.month}>{monthLabel(b.month, true)}</span>
        ))}
      </figcaption>
    </figure>
  )
}

const RINGS = [
  { r: 86, tone: 'strong' },
  { r: 66, tone: 'mid' },
  { r: 46, tone: 'soft' },
] as const

/** The live sites as rings, one a window, each as full as its share viewed in it. */
export function ActivityRings({ lap }: { lap: UsageTally }) {
  const f = funnel(lap)
  return (
    <div className="usage-rings">
      <figure className="usage-rings-figure">
        <svg viewBox="0 0 200 200" role="img" aria-label={funnelSummary(f)}>
          {f.rings.map((ring, i) => {
            const { r, tone } = RINGS[i] ?? RINGS[0]
            const c = 2 * Math.PI * r
            return (
              <g key={ring.key} data-tone={tone}>
                <circle className="usage-ring-track" cx={100} cy={100} r={r} />
                {ring.share > 0 && (
                  <circle
                    className="usage-ring-arc"
                    cx={100}
                    cy={100}
                    r={r}
                    strokeDasharray={c}
                    style={
                      {
                        '--ring-c': c,
                        '--ring-off': c * (1 - ring.share),
                        '--i': i,
                      } as CSSProperties
                    }
                  />
                )}
              </g>
            )
          })}
        </svg>
        <figcaption className="usage-rings-centre" aria-hidden="true">
          <strong className="tabular-nums">
            <CountUp value={f.live} />
          </strong>
          <span>live {f.live === 1 ? 'site' : 'sites'}</span>
        </figcaption>
      </figure>
      <div className="usage-rings-legend">
        <dl>
          {f.rings.map((ring, i) => (
            <div key={ring.key} data-tone={RINGS[i]?.tone}>
              <dt>
                <span className="usage-ring-swatch" aria-hidden="true" />
                {ring.label}
              </dt>
              <dd className="tabular-nums">
                <strong>{ring.count.toLocaleString()}</strong>{' '}
                <span className="text-muted">{percent(ring.share)}</span>
              </dd>
            </div>
          ))}
        </dl>
        <p className="usage-never">
          <EyeSlashIcon className="size-5 flex-none" aria-hidden="true" />
          <span>
            <strong className="tabular-nums">{f.neverViewed.count.toLocaleString()}</strong>{' '}
            {f.neverViewed.count === 1 ? 'live site has' : 'live sites have'} never been viewed
            {f.live > 0 && <span className="text-muted"> ({percent(f.neverViewed.share)})</span>}
          </span>
        </p>
        <p className="text-xs text-muted tabular-nums">
          {lap.sites.toLocaleString()} {lap.sites === 1 ? 'site' : 'sites'} in all;{' '}
          {(lap.sites - lap.live).toLocaleString()} archived or not published yet.
        </p>
      </div>
    </div>
  )
}

/** The most viewed over 28 days, each with its bar against the first. */
export function MostViewed({ top }: { top: UsageTally['top'] }) {
  if (top.length === 0) {
    return <p className="usage-empty">No site has been viewed in the last 28 days.</p>
  }
  return (
    <ol className="usage-board">
      {leaderboard(top).map(s => (
        <li
          key={s.name}
          data-podium={s.podium ? s.rank : undefined}
          style={{ '--share': s.ratio, '--i': s.rank - 1 } as CSSProperties}
        >
          <span className="usage-rank tabular-nums" aria-hidden="true">
            {s.rank}
          </span>
          <Link to={siteHref(s.name)} className="usage-board-name link link-hover">
            <span className="sr-only">{s.rank}. </span>
            {s.name}
          </Link>
          <span className="usage-board-views tabular-nums">{countLabel(s.views, 'views')}</span>
          <span className="usage-board-bar" aria-hidden="true" />
        </li>
      ))}
    </ol>
  )
}

/** The live sites unused longest, each name fading as the time unused grows. */
export function GatheringDust({ idle }: { idle: UsageTally['idle'] }) {
  if (idle.length === 0) return <p className="usage-empty">No live sites yet.</p>
  const dusty = gatheringDust(idle)
  if (dusty.length === 0) {
    return (
      <p className="usage-empty">
        Every live site was viewed or pushed in the last {DUST_AFTER_DAYS} days.
      </p>
    )
  }
  return (
    <ul className="usage-dust">
      {dusty.map(s => (
        <li key={s.name} style={{ '--dust': s.dust } as CSSProperties}>
          <Link to={siteHref(s.name)} className="usage-dust-name link link-hover">
            {s.name}
          </Link>
          <span className="usage-dust-age tabular-nums" title={fullDate(s.lastActiveAt)}>
            unused for {s.idleFor}
          </span>
        </li>
      ))}
    </ul>
  )
}
