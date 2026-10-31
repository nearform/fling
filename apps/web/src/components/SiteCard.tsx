/**
 * One of your sites in the list. As a row (`layout` list): its thumbnail, when the instance has
 * thumbnails, then its name (and when it was updated), the two links people share (Review, when
 * the instance has comments, and View, each with a copy button), then its badges on the right.
 * One line on wide screens, with the links in the same place on every row; on narrow ones it
 * stacks (name, badges, links) so the name keeps its room. As a card (`layout` grid), small so
 * many fit a row: the thumbnail on top, then the name on one line, when it was updated with the
 * badges as icons beside it, and the links as icon buttons (their names in tooltips). Either way
 * the whole of it opens the site page, where everything else is managed: the name is the link,
 * stretched over it, and the buttons sit above it. Archived sites are offline, so their URL is
 * plain text and they can't be reviewed.
 */
import type { Site } from '@fling/shared'
import { ChevronRightIcon } from '@heroicons/react/24/outline'
import { useInstance } from '../hooks/instance'
import { displayUrl, fullDate, timeAgo } from '../lib/format'
import { type SitesLayout, siteHref } from '../lib/sites'
import { CardLink } from './CardLink'
import { ReviewButton, ViewSiteButton } from './SiteButtons'
import { SiteThumbnail } from './SiteThumbnail'
import { SiteBadges } from './site/badges'

export function SiteCard({ site, layout = 'list' }: { site: Site; layout?: SitesLayout }) {
  const instance = useInstance()
  // Review mode: the instance has comments, and the site is being served.
  const reviewable = instance?.capabilities.comments === true && !site.archived
  const thumbs = instance?.capabilities.thumbnails === true

  const grid = layout === 'grid'
  const name = (
    <h2
      className={
        grid
          ? 'truncate text-sm font-semibold leading-tight'
          : 'text-base font-semibold leading-tight [overflow-wrap:anywhere]'
      }
    >
      {/* Yours, or one you publish: its site page. */}
      <CardLink name={site.name} target={{ kind: 'site-page', to: siteHref(site.name) }} />
    </h2>
  )
  const updated = (
    <p className="mt-0.5 truncate text-xs text-secondary">
      <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
    </p>
  )
  const links = (
    <>
      {reviewable && <ReviewButton name={site.name} compact={grid} />}
      {site.archived ? (
        <span className="min-w-0 truncate text-sm text-muted" title={site.url}>
          {displayUrl(site.url)}
        </span>
      ) : (
        <ViewSiteButton name={site.name} url={site.url} compact={grid} />
      )}
    </>
  )

  if (grid) {
    return (
      <article className="surface-panel site-tile">
        <SiteThumbnail name={site.name} thumbnail={site.thumbnail} />
        <div className="site-tile-body">
          {name}
          <div className="site-tile-meta">
            <span className="truncate" title={fullDate(site.updatedAt)}>
              {timeAgo(site.updatedAt)}
            </span>
            <span className="site-tile-badges relative z-10">
              <SiteBadges site={site} compact />
            </span>
          </div>
          <div className="site-tile-links">{links}</div>
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
