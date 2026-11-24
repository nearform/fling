/**
 * A site's days in the Sites list, from the list itself (`GET /api/sites?metrics=1`, the site's
 * `days`): its views a day as a small trend (`DayTrend`), coloured against the busiest day of any
 * of the sites listed, with their total beside them. Only where the instance counts views
 * (lib/usage.ts `activityShown`); nothing for a site the answer has no days for. In a row it is as
 * tall as the row's buttons; on a card (`block`) it takes a line of its own, as wide as the card.
 */
import { METRIC_DAYS } from '@fling/shared/metrics'
import { countLabel } from '../../lib/metrics'
import { DayTrend } from '../usage/DayTrend'

export function SiteSpark({
  views,
  scale,
  block = false,
  tall = false,
}: {
  views: readonly number[]
  /** the busiest day of any of the sites listed, which colours every site's bars alike */
  scale?: number
  /** a line of its own, as wide as its card */
  block?: boolean
  /** as tall as its row's buttons */
  tall?: boolean
}) {
  const total = views.reduce((n, c) => n + c, 0)
  const label = `${countLabel(total, 'views')} in ${METRIC_DAYS} days`
  return (
    <span
      className="site-spark"
      title={label}
      data-block={block ? '' : undefined}
      data-tall={tall ? '' : undefined}
    >
      <DayTrend counts={views} {...(scale === undefined ? {} : { scale })} />
      <span className="tabular-nums">{total.toLocaleString()}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
