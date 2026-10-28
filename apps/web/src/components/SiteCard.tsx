/**
 * One site as a row of the list. The first line names it (and when it was updated), with its
 * badges on the right; the second holds the two links people share: review (when the instance
 * has comments) and the site itself, each with a copy button. The whole row opens the site page,
 * where everything else is managed: the name is the link, stretched over the row, and the
 * buttons sit above it. Archived sites are offline, so their URL is plain text and they can't
 * be reviewed.
 */
import type { Site } from '@fling/shared'
import {
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftRightIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline'
import { Link } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { displayUrl, fullDate, shortVersion, timeAgo } from '../lib/format'
import { reviewHref } from '../lib/review'
import { siteHref } from '../lib/sites'
import { CopyButton } from './CopyButton'
import { SiteBadges } from './site/badges'

const copyClass = 'btn btn-ghost btn-xs btn-square h-7 min-h-7 w-7 shrink-0'
const linkClass =
  'btn btn-sm h-8 min-h-8 min-w-0 justify-start gap-1.5 px-2.5 font-normal normal-case'

export function SiteCard({ site }: { site: Site }) {
  const instance = useInstance()
  // Review mode: the instance has comments, and the site is being served.
  const reviewable = instance?.capabilities.comments === true && !site.archived
  const reviewUrl = `${window.location.origin}${reviewHref(site.name)}`

  return (
    <article className="surface-panel relative px-4 py-3 transition-colors hover:border-[var(--border-control)]">
      {/* Line 1: name and when it was updated; badges on the right */}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-tight break-all">
            <Link
              to={siteHref(site.name)}
              className="after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-[var(--focus-ring,currentColor)]"
              title={`Manage ${site.name}: access, versions, archive and delete`}
            >
              {site.name}
            </Link>
          </h2>
          <p className="mt-0.5 text-xs text-secondary">
            <span className="max-sm:sr-only">Updated </span>
            <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
            <span className="max-sm:hidden">
              {' · '}
              <code className="text-xs" title={site.currentVersionId ?? undefined}>
                {shortVersion(site.currentVersionId)}
              </code>
            </span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <SiteBadges site={site} />
          <ChevronRightIcon className="h-4 w-4 text-muted" aria-hidden />
        </div>
      </div>

      {/* Line 2: the links to share, above the stretched row link */}
      <div className="relative z-10 mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {reviewable && (
          <span className="flex min-w-0 max-w-full items-center">
            <Link
              to={reviewHref(site.name)}
              className={`${linkClass} btn-primary`}
              title="Open the site with its comments: the link to share for feedback"
            >
              <ChatBubbleLeftRightIcon className="h-4 w-4 shrink-0" aria-hidden />
              Review
            </Link>
            <CopyButton
              text={reviewUrl}
              label={`Copy the review link of ${site.name}`}
              className={copyClass}
            />
          </span>
        )}
        <span className="flex min-w-0 max-w-full items-center">
          {site.archived ? (
            <span className="truncate px-2.5 text-sm text-muted">{displayUrl(site.url)}</span>
          ) : (
            <a
              href={site.url}
              target="_blank"
              rel="noreferrer"
              className={`${linkClass} btn-ghost border-[var(--border-control)]`}
            >
              <ArrowTopRightOnSquareIcon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{displayUrl(site.url)}</span>
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
          <CopyButton
            text={site.url}
            label={`Copy the URL of ${site.name}`}
            className={copyClass}
          />
        </span>
      </div>
    </article>
  )
}
