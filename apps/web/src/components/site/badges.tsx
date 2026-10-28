/**
 * The badges a site wears in the list and on its page: its access level (or archived), with how
 * many people and teams a list names, and whether it has a share link.
 */
import { type AccessLevel, accessDescription, type Site, siteAccessLevel } from '@fling/shared'
import {
  GlobeAltIcon,
  LinkIcon,
  LockClosedIcon,
  UserGroupIcon,
  UserIcon,
} from '@heroicons/react/24/outline'
import { useInstance } from '../../hooks/instance'
import { accessBadgeLabel } from '../../lib/audience'
import { audienceFor } from '../../lib/instance'

const ICONS: Record<AccessLevel, typeof GlobeAltIcon> = {
  only_me: UserIcon,
  members: LockClosedIcon,
  groups: UserGroupIcon,
  people: UserGroupIcon,
  public: GlobeAltIcon,
}

/** `Only you`, `Everyone signed in`, `Specific people · 2 people · 1 group`, `Public`. */
export function AccessBadge({ site }: { site: Site }) {
  const members = audienceFor(useInstance())
  const level = siteAccessLevel(site)
  const Icon = ICONS[level]
  return (
    <span
      className={`badge badge-sm gap-1 ${level === 'public' ? 'tone-info' : 'tone-primary'}`}
      title={accessDescription(level, members)}
    >
      <Icon className="h-3 w-3" aria-hidden /> {accessBadgeLabel(site)}
    </span>
  )
}

/** The access level (or archived), plus "Shared" while a live site has a share link. */
export function SiteBadges({ site }: { site: Site }) {
  return (
    <>
      {site.archived ? (
        <span className="badge badge-sm badge-ghost">Archived</span>
      ) : (
        <AccessBadge site={site} />
      )}
      {site.shareUrl && !site.archived && (
        <span className="badge badge-sm badge-ghost gap-1" title="Has a share link">
          <LinkIcon className="h-3 w-3" aria-hidden />
          Shared
        </span>
      )}
    </>
  )
}
