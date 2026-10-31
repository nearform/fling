/**
 * One site of the instance in All sites (admins). As a row (`layout` list): its thumbnail, when
 * the instance has thumbnails, its name, linking to its site page (an admin manages anyone's), then
 * its owner and when it was updated (plain muted text, on the name's left edge); Review (when the
 * instance has comments) and View; then its access level (or archived, or not yet published).
 * Laid out like your own sites' rows. As a card (`layout` grid): the thumbnail on top, then the
 * same.
 */
import type { AdminSite } from '@fling/shared'
import { Link } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { displayUrl, fullDate, timeAgo } from '../lib/format'
import { type SitesLayout, siteHref } from '../lib/sites'
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

  const about = (
    <div className="min-w-0 [grid-area:name]">
      <h2 className="text-base font-semibold leading-tight [overflow-wrap:anywhere]">
        <Link
          to={siteHref(site.name)}
          className="hover:underline"
          title={`Manage ${site.name}: access, versions, archive and delete`}
        >
          {site.name}
        </Link>
      </h2>
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
      {reviewable && <ReviewButton name={site.name} />}
      {site.archived ? (
        <span className="truncate text-sm text-muted">{displayUrl(site.url)}</span>
      ) : (
        <ViewSiteButton name={site.name} url={site.url} />
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

  if (layout === 'grid') {
    return (
      <article className="surface-panel site-tile">
        <SiteThumbnail name={site.name} thumbnail={site.thumbnail} />
        <div className="site-tile-body">
          {about}
          <div className="-mt-1 flex flex-wrap items-center gap-1.5">{badges}</div>
          <div className="site-tile-links flex min-w-0 flex-wrap items-center gap-2">{links}</div>
        </div>
      </article>
    )
  }

  return (
    <article
      className={`surface-panel grid items-center gap-x-4 gap-y-1.5 px-4 py-2 ${
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
