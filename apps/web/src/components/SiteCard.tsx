/**
 * One of your sites in the list. As a row (`layout` list): its thumbnail, when the instance has
 * thumbnails, then its name (and when it was updated), the two links people share (Review, when
 * the instance has comments, and View, each with a copy button), then its badges on the right.
 * One line on wide screens, with the links in the same place on every row; on narrow ones it
 * stacks (name, badges, links) so the name keeps its room. As a card (`layout` grid): the
 * thumbnail on top, then the name, when it was updated with the badges beside it, and the links. Either way
 * the whole of it opens the site page, where everything else is managed: the name is the link,
 * stretched over it, and the buttons sit above it. Archived sites are offline, so their URL is
 * plain text and they can't be reviewed.
 */
import type { Site } from '@fling/shared'
import { ChevronRightIcon } from '@heroicons/react/24/outline'
import { Link } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { displayUrl, fullDate, timeAgo } from '../lib/format'
import { type SitesLayout, siteHref } from '../lib/sites'
import { ReviewButton, ViewSiteButton } from './SiteButtons'
import { SiteThumbnail } from './SiteThumbnail'
import { SiteBadges } from './site/badges'

const stretched =
  'site-tile-link after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-[var(--focus-ring,currentColor)]'

export function SiteCard({ site, layout = 'list' }: { site: Site; layout?: SitesLayout }) {
  const instance = useInstance()
  // Review mode: the instance has comments, and the site is being served.
  const reviewable = instance?.capabilities.comments === true && !site.archived
  const thumbs = instance?.capabilities.thumbnails === true

  const name = (
    <h2 className="text-base font-semibold leading-tight [overflow-wrap:anywhere]">
      <Link
        to={siteHref(site.name)}
        className={stretched}
        title={`Manage ${site.name}: access, versions, archive and delete`}
      >
        {site.name}
      </Link>
    </h2>
  )
  const updated = (
    <p className="mt-0.5 truncate text-xs text-secondary">
      <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
    </p>
  )
  const links = (
    <>
      {reviewable && <ReviewButton name={site.name} />}
      {site.archived ? (
        <span className="truncate text-sm text-muted">{displayUrl(site.url)}</span>
      ) : (
        <ViewSiteButton name={site.name} url={site.url} />
      )}
    </>
  )

  if (layout === 'grid') {
    return (
      <article className="surface-panel site-tile">
        <SiteThumbnail name={site.name} thumbnail={site.thumbnail} />
        <div className="site-tile-body">
          <div className="min-w-0">
            {name}
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-secondary">
              <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
              <SiteBadges site={site} />
            </div>
          </div>
          <div className="site-tile-links relative z-10 flex min-w-0 flex-wrap items-center gap-2">
            {links}
          </div>
        </div>
      </article>
    )
  }

  return (
    <article
      className={`surface-panel relative grid items-center gap-x-4 gap-y-1.5 px-4 py-2 transition-colors hover:border-[var(--border-control)] ${
        thumbs
          ? "grid-cols-[4.5rem_minmax(0,1fr)] [grid-template-areas:'thumb_name'_'thumb_badges'_'links_links'] md:grid-cols-[4.5rem_minmax(10rem,1fr)_auto_minmax(max-content,14rem)] md:[grid-template-areas:'thumb_name_links_badges']"
          : "grid-cols-[minmax(0,1fr)] [grid-template-areas:'name'_'badges'_'links'] md:grid-cols-[minmax(10rem,1fr)_auto_minmax(max-content,14rem)] md:[grid-template-areas:'name_links_badges']"
      }`}
    >
      {thumbs && (
        <SiteThumbnail
          name={site.name}
          thumbnail={site.thumbnail}
          className="[grid-area:thumb] self-center"
        />
      )}
      <div className="min-w-0 [grid-area:name]">
        {name}
        {updated}
      </div>

      {/* The links to share, above the stretched row link */}
      <div className="relative z-10 flex min-w-0 items-center gap-x-2 [grid-area:links]">
        {links}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 [grid-area:badges] md:justify-end">
        <SiteBadges site={site} />
        <ChevronRightIcon className="h-4 w-4 text-muted max-md:hidden" aria-hidden />
      </div>
    </article>
  )
}
