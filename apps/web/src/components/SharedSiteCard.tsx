/**
 * One site shared with you in the Shared list. As a row (`layout` list): its thumbnail, when the
 * instance has thumbnails, its name, then who owns it, how it reached you (your address, or a
 * group you are in) and when it was updated, as plain muted text that shares the name's left edge;
 * then Review (when the instance has comments) and View, laid out like your own sites' rows. As a
 * card (`layout` grid), small so many fit a row: the thumbnail on top, then the same on short
 * lines (the owner on one, how and when on the next) and the links as icon buttons. Either way the
 * name is the card's link (CardLink), to the site's review page (or the site itself, without
 * comments): it has no site page for you, since only its owners and publishers manage it.
 */
import { type SharedSite, sharedVia } from '@fling/shared'
import { useInstance } from '../hooks/instance'
import { fullDate, timeAgo } from '../lib/format'
import type { SitesLayout } from '../lib/sites'
import { CardLink, siteCardTarget } from './CardLink'
import { ReviewButton, ViewSiteButton } from './SiteButtons'
import { SiteThumbnail } from './SiteThumbnail'

export function SharedSiteCard({
  site,
  layout = 'list',
}: {
  site: SharedSite
  layout?: SitesLayout
}) {
  const instance = useInstance()
  const reviewable = instance?.capabilities.comments === true
  const thumbs = instance?.capabilities.thumbnails === true

  // Shared with you to view: its review page (or the site, without comments). Only its owners and
  // publishers have its site page, and they find it in their own list.
  const link = (
    <CardLink name={site.name} target={siteCardTarget(site, { manages: false, reviewable })} />
  )
  const about = (
    <div className="min-w-0">
      <h2 className="text-base font-semibold leading-tight [overflow-wrap:anywhere]">{link}</h2>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-secondary">
        <span className="min-w-0 truncate" title={site.owner}>
          {site.owner}
        </span>
        <span>· through {sharedVia(site)}</span>
        <span>
          · <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
        </span>
      </p>
    </div>
  )
  const links = (
    <>
      {reviewable && <ReviewButton name={site.name} compact={layout === 'grid'} />}
      <ViewSiteButton name={site.name} url={site.url} compact={layout === 'grid'} />
    </>
  )

  if (layout === 'grid') {
    return (
      <article className="surface-panel site-tile">
        <SiteThumbnail name={site.name} thumbnail={site.thumbnail} />
        <div className="site-tile-body">
          <h2 className="truncate text-sm font-semibold leading-tight">{link}</h2>
          <p className="site-tile-meta" title={`${site.owner}, through ${sharedVia(site)}`}>
            <span className="truncate">{site.owner}</span>
          </p>
          <p className="site-tile-meta">
            <span className="truncate">
              through {sharedVia(site)} ·{' '}
              <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
            </span>
          </p>
          <div className="site-tile-links">{links}</div>
        </div>
      </article>
    )
  }

  return (
    <article
      className={`surface-panel relative grid items-center gap-x-4 gap-y-1.5 px-4 py-2 transition-colors hover:border-[var(--border-control)] ${
        thumbs
          ? 'grid-cols-[4.5rem_minmax(0,1fr)] md:grid-cols-[4.5rem_minmax(10rem,1fr)_auto]'
          : 'grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(10rem,1fr)_auto]'
      }`}
    >
      {thumbs && (
        <SiteThumbnail name={site.name} thumbnail={site.thumbnail} className="max-md:row-span-2" />
      )}
      {about}
      <div className="flex min-w-0 items-center gap-x-2">{links}</div>
    </article>
  )
}
