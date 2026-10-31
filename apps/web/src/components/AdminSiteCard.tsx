/**
 * One site of the instance in All sites (admins). As a row (`layout` list): its thumbnail, when
 * the instance has thumbnails, its name, the card's link to its site page (CardLink; an admin
 * manages anyone's), then its owner and when it was updated (plain muted text, on the name's left
 * edge); Review (when the instance has comments) and View; then its access level (or archived, or
 * not yet published).
 * Laid out like your own sites' rows. As a card (`layout` grid), small so many fit a row: the
 * thumbnail on top, then the name and owner on a line each, when it was updated with the badges as
 * icons, and the links as icon buttons.
 */
import type { AdminSite } from '@fling/shared'
import { useInstance } from '../hooks/instance'
import { displayUrl, fullDate, timeAgo } from '../lib/format'
import { type SitesLayout, siteHref } from '../lib/sites'
import { CardLink } from './CardLink'
import { ReviewButton, ViewSiteButton } from './SiteButtons'
import { SiteThumbnail } from './SiteThumbnail'
import { AccessBadge } from './site/badges'

export function AdminSiteCard({
  site,
  mine,
  layout = 'list',
}: {
  site: AdminSite
  mine: boolean
  layout?: SitesLayout
}) {
  const instance = useInstance()
  const reviewable = instance?.capabilities.comments === true && !site.archived
  const thumbs = instance?.capabilities.thumbnails === true
  const visibility = site.access === 'public' ? 'public' : 'private'
  const grid = layout === 'grid'

  // An admin manages any site: its site page.
  const link = <CardLink name={site.name} target={{ kind: 'site-page', to: siteHref(site.name) }} />
  const about = (
    <div className="min-w-0 [grid-area:name]">
      <h2 className="text-base font-semibold leading-tight [overflow-wrap:anywhere]">{link}</h2>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-secondary">
        <span className="min-w-0 truncate" title={site.owner}>
          {site.owner}
        </span>
        <span>
          · <span title={fullDate(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
        </span>
      </p>
    </div>
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
  const badges = (
    <>
      {site.archived ? (
        <span className="badge badge-sm badge-ghost">Archived</span>
      ) : (
        <AccessBadge
          site={{ access: site.access, visibility }}
          compact={grid}
          {...(site.access === 'only_me' && !mine && { label: 'Only its owner' })}
        />
      )}
      {!site.live && !site.archived && (
        <span className="badge badge-sm badge-ghost" title="It has no published version yet">
          Not published
        </span>
      )}
    </>
  )

  if (grid) {
    return (
      <article className="surface-panel site-tile">
        <SiteThumbnail name={site.name} thumbnail={site.thumbnail} />
        <div className="site-tile-body">
          <h2 className="truncate text-sm font-semibold leading-tight">{link}</h2>
          <p className="site-tile-meta" title={site.owner}>
            <span className="truncate">{site.owner}</span>
          </p>
          <div className="site-tile-meta">
            <span className="truncate" title={fullDate(site.updatedAt)}>
              {timeAgo(site.updatedAt)}
            </span>
            <span className="site-tile-badges">{badges}</span>
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
          ? "grid-cols-[4.5rem_minmax(0,1fr)] [grid-template-areas:'thumb_name'_'thumb_badges'_'links_links'] md:grid-cols-[4.5rem_minmax(10rem,1fr)_auto_minmax(max-content,10rem)] md:[grid-template-areas:'thumb_name_links_badges']"
          : "grid-cols-[minmax(0,1fr)] [grid-template-areas:'name'_'badges'_'links'] md:grid-cols-[minmax(10rem,1fr)_auto_minmax(max-content,10rem)] md:[grid-template-areas:'name_links_badges']"
      }`}
    >
      {thumbs && (
        <SiteThumbnail
          name={site.name}
          thumbnail={site.thumbnail}
          className="[grid-area:thumb] self-center"
        />
      )}
      {about}
      <div className="flex min-w-0 items-center gap-x-2 [grid-area:links]">{links}</div>
      <div className="flex flex-wrap items-center gap-1.5 [grid-area:badges] md:justify-end">
        {badges}
      </div>
    </article>
  )
}
