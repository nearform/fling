/**
 * One site as a row of the list: its name (linking to the site page), badges and URL on the
 * first line, when it was updated on the second, and the quick actions: open (the URL), copy the
 * link, review (when the instance has comments) and Manage. Everything else about a site is on
 * its page. Archived sites are offline, so their URL is plain text and they can't be reviewed.
 */
import type { Site } from '@fling/shared'
import {
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline'
import { Link } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { displayUrl, fullDate, shortVersion, timeAgo } from '../lib/format'
import { reviewHref } from '../lib/review'
import { siteHref } from '../lib/sites'
import { CopyButton } from './CopyButton'
import { SiteBadges } from './site/badges'

const quickAction = 'btn btn-ghost btn-xs h-6 min-h-6 gap-1 px-1.5 font-normal'

export function SiteCard({ site }: { site: Site }) {
  const instance = useInstance()
  // Review mode: the instance has comments, and the site is being served.
  const reviewable = instance?.capabilities.comments === true && !site.archived

  return (
    <article className="surface-panel px-4 py-2.5">
      <div className="flex items-start gap-2">
        {/* Line 1: name, badges, URL */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <h2 className="text-base font-medium leading-tight break-all">
            <Link to={siteHref(site.name)} className="link link-hover">
              {site.name}
            </Link>
          </h2>
          <SiteBadges site={site} />
          <span className="flex min-w-0 max-w-full items-center">
            {site.archived ? (
              <span className="truncate text-sm text-muted">{displayUrl(site.url)}</span>
            ) : (
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
            )}
            <CopyButton
              text={site.url}
              label={`Copy the URL of ${site.name}`}
              className="btn btn-ghost btn-xs btn-square h-6 min-h-6 w-6 shrink-0"
            />
          </span>
        </div>

        {/* Quick actions */}
        <div className="flex shrink-0 items-center gap-0.5">
          {reviewable && (
            <Link
              to={reviewHref(site.name)}
              className={quickAction}
              title="Open the site with its comments"
            >
              <ChatBubbleLeftRightIcon className="h-3.5 w-3.5" aria-hidden />
              Review
            </Link>
          )}
          <Link
            to={siteHref(site.name)}
            className={quickAction}
            title="Access, versions, archive and delete"
            aria-label={`Manage ${site.name}`}
          >
            <Cog6ToothIcon className="h-3.5 w-3.5" aria-hidden />
            Manage
          </Link>
        </div>
      </div>

      {/* Line 2: when it was updated, and the version it serves */}
      <div className="mt-0.5 text-xs text-secondary">
        <span className="max-sm:sr-only">Updated </span>
        <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
        <span className="max-sm:hidden">
          {' · '}
          <code className="text-xs" title={site.currentVersionId ?? undefined}>
            {shortVersion(site.currentVersionId)}
          </code>
        </span>
      </div>
    </article>
  )
}
