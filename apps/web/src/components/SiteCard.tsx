/**
 * One site as a row of the list: its name (and when it was updated), the two links people share
 * (Review, when the instance has comments, and View, each with a copy button), then
 * its badges on the right. One line on wide screens, with the links in the same place on every
 * row; on narrow ones it stacks (name, badges, links) so the name keeps its room. The whole row opens the site page, where everything else
 * is managed: the name is the link, stretched over the row, and the buttons sit above it.
 * Archived sites are offline, so their URL is plain text and they can't be reviewed.
 */
import type { Site } from '@fling/shared'
import { ChevronRightIcon } from '@heroicons/react/24/outline'
import { Link } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { displayUrl, fullDate, timeAgo } from '../lib/format'
import { siteHref } from '../lib/sites'
import { ReviewButton, ViewSiteButton } from './SiteButtons'
import { SiteBadges } from './site/badges'

export function SiteCard({ site }: { site: Site }) {
  const instance = useInstance()
  // Review mode: the instance has comments, and the site is being served.
  const reviewable = instance?.capabilities.comments === true && !site.archived

  return (
    <article className="surface-panel relative grid grid-cols-[minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 px-4 py-2 transition-colors [grid-template-areas:'name'_'badges'_'links'] hover:border-[var(--border-control)] md:grid-cols-[minmax(10rem,1fr)_auto_minmax(max-content,14rem)] md:[grid-template-areas:'name_links_badges']">
      <div className="min-w-0 [grid-area:name]">
        <h2 className="text-base font-semibold leading-tight [overflow-wrap:anywhere]">
          <Link
            to={siteHref(site.name)}
            className="after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-[var(--focus-ring,currentColor)]"
            title={`Manage ${site.name}: access, versions, archive and delete`}
          >
            {site.name}
          </Link>
        </h2>
        <p className="mt-0.5 truncate text-xs text-secondary">
          <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
        </p>
      </div>

      {/* The links to share, above the stretched row link */}
      <div className="relative z-10 flex min-w-0 items-center gap-x-2 [grid-area:links]">
        {reviewable && <ReviewButton name={site.name} />}
        {site.archived ? (
          <span className="truncate text-sm text-muted">{displayUrl(site.url)}</span>
        ) : (
          <ViewSiteButton name={site.name} url={site.url} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 [grid-area:badges] md:justify-end">
        <SiteBadges site={site} />
        <ChevronRightIcon className="h-4 w-4 text-muted max-md:hidden" aria-hidden />
      </div>
    </article>
  )
}
