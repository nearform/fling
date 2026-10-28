/**
 * One site shared with you as a row of the Shared list: its name, then who owns it, how it reached
 * you (your address, or a group you are in) and when it was updated; then Review Site (when the
 * instance has comments) and View Site, laid out like your own sites' rows. It has no site page:
 * only its owner manages it.
 */
import { type SharedSite, sharedVia } from '@fling/shared'
import { useInstance } from '../hooks/instance'
import { fullDate, timeAgo } from '../lib/format'
import { EmailBadge } from './EmailBadge'
import { ReviewButton, ViewSiteButton } from './SiteButtons'

export function SharedSiteCard({ site }: { site: SharedSite }) {
  const instance = useInstance()
  const reviewable = instance?.capabilities.comments === true

  return (
    <article className="surface-panel grid grid-cols-[minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 px-4 py-2 md:grid-cols-[minmax(10rem,1fr)_auto]">
      <div className="min-w-0">
        <h2 className="text-base font-semibold leading-tight [overflow-wrap:anywhere]">
          {site.name}
        </h2>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-secondary">
          <EmailBadge email={site.owner} size="sm" />
          <span>· through {sharedVia(site)}</span>
          <span>
            · <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
          </span>
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-x-2">
        {reviewable && <ReviewButton name={site.name} />}
        <ViewSiteButton name={site.name} url={site.url} />
      </div>
    </article>
  )
}
