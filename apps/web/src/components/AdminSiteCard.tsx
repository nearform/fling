/**
 * One site of the instance as a row of All sites (admins): its name, then its owner and when it
 * was updated (plain muted text, on the name's left edge); Review (when the instance has
 * comments) and View; then its access level
 * (or archived, or not yet published). Laid out like your own sites' rows. Only your own sites
 * link to their site page: anyone else's answers you as it answers any member, so a restricted
 * one opens only by impersonating its owner.
 */
import type { AdminSite } from '@fling/shared'
import { Link } from 'react-router-dom'
import { useInstance } from '../hooks/instance'
import { displayUrl, fullDate, timeAgo } from '../lib/format'
import { siteHref } from '../lib/sites'
import { ReviewButton, ViewSiteButton } from './SiteButtons'
import { AccessBadge } from './site/badges'

export function AdminSiteCard({ site, mine }: { site: AdminSite; mine: boolean }) {
  const instance = useInstance()
  const reviewable = instance?.capabilities.comments === true && !site.archived
  const visibility = site.access === 'public' ? 'public' : 'private'

  return (
    <article className="surface-panel grid grid-cols-[minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 px-4 py-2 [grid-template-areas:'name'_'badges'_'links'] md:grid-cols-[minmax(10rem,1fr)_auto_minmax(max-content,10rem)] md:[grid-template-areas:'name_links_badges']">
      <div className="min-w-0 [grid-area:name]">
        <h2 className="text-base font-semibold leading-tight [overflow-wrap:anywhere]">
          {mine ? (
            <Link
              to={siteHref(site.name)}
              className="hover:underline"
              title={`Manage ${site.name}: access, versions, archive and delete`}
            >
              {site.name}
            </Link>
          ) : (
            site.name
          )}
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

      <div className="flex min-w-0 items-center gap-x-2 [grid-area:links]">
        {reviewable && <ReviewButton name={site.name} />}
        {site.archived ? (
          <span className="truncate text-sm text-muted">{displayUrl(site.url)}</span>
        ) : (
          <ViewSiteButton name={site.name} url={site.url} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 [grid-area:badges] md:justify-end">
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
      </div>
    </article>
  )
}
