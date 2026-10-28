/**
 * One site shared with you as a row of the Shared list: its name and URL (both opening the site),
 * who owns it and how it reached you (your address, or a group you are in) on the second line with
 * when it was updated, and the review page when the instance has comments. It has no site page or
 * Manage link: only its owner manages it.
 */
import { type SharedSite, sharedVia } from '@fling/shared'
import { ArrowTopRightOnSquareIcon, ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline'
import { Link } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { displayUrl, fullDate, timeAgo } from '../lib/format'
import { reviewHref } from '../lib/review'
import { CopyButton } from './CopyButton'
import { EmailBadge } from './EmailBadge'

const quickAction = 'btn btn-ghost btn-xs h-6 min-h-6 gap-1 px-1.5 font-normal'

export function SharedSiteCard({ site }: { site: SharedSite }) {
  const instance = useInstance()
  const reviewable = instance?.capabilities.comments === true

  return (
    <article className="surface-panel px-4 py-2.5">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <h2 className="text-base font-medium leading-tight break-all">
            <a href={site.url} target="_blank" rel="noreferrer" className="link link-hover">
              {site.name}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </h2>
          <span className="flex min-w-0 max-w-full items-center">
            <a
              href={site.url}
              target="_blank"
              rel="noreferrer"
              className="link link-hover inline-flex min-w-0 items-center gap-1 text-sm"
            >
              <span className="truncate">{displayUrl(site.url)}</span>
              <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <CopyButton
              text={site.url}
              label={`Copy the URL of ${site.name}`}
              className="btn btn-ghost btn-xs btn-square h-6 min-h-6 w-6 shrink-0"
            />
          </span>
        </div>

        {reviewable && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Link
              to={reviewHref(site.name)}
              className={quickAction}
              title="Open the site with its comments"
            >
              <ChatBubbleLeftRightIcon className="h-3.5 w-3.5" aria-hidden />
              Review
            </Link>
          </div>
        )}
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-secondary">
        <EmailBadge email={site.owner} size="sm" />
        <span>· through {sharedVia(site)}</span>
        <span className="max-sm:hidden">
          · Updated <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
        </span>
      </div>
    </article>
  )
}
