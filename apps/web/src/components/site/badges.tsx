/**
 * The badges a site wears in the list and on its page: visibility (or archived), who it is
 * restricted to, and share link.
 */
import type { Site } from '@fling/shared'
import { GlobeAltIcon, LinkIcon, LockClosedIcon, UserGroupIcon } from '@heroicons/react/24/outline'
import { useInstance } from '../../hooks/instance'
import { audienceWho, restrictedLabel } from '../../lib/audience'
import { audienceFor } from '../../lib/instance'

export function VisibilityBadge({ visibility }: { visibility: Site['visibility'] }) {
  const audience = audienceFor(useInstance())
  return visibility === 'public' ? (
    <span
      className="badge badge-sm tone-info gap-1"
      title="Anyone with the URL can open the site; reviewing it still needs sign-in"
    >
      <GlobeAltIcon className="h-3 w-3" /> Public
    </span>
  ) : (
    <span className="badge badge-sm tone-primary gap-1" title={`Private: open to ${audience}`}>
      <LockClosedIcon className="h-3 w-3" /> Sign-in required
    </span>
  )
}

/**
 * A private site limited to its audience: "Restricted · 3 people · 1 group". `size` counts the
 * addresses and groups together; `groups`, how many of them are groups.
 */
export function RestrictedBadge({ size, groups = 0 }: { size: number; groups?: number }) {
  const people = Math.max(0, size - groups)
  return (
    <span
      className="badge badge-sm tone-primary gap-1"
      title={`Only you and ${audienceWho(people, groups)} can open it`}
    >
      <UserGroupIcon className="h-3 w-3" aria-hidden /> {restrictedLabel(people, groups)}
    </span>
  )
}

/**
 * Archived, restricted (to how many) or the visibility; plus "Shared" while a live site has a
 * share link. A restricted site is private too, so it wears only the more specific badge.
 */
export function SiteBadges({ site }: { site: Site }) {
  return (
    <>
      {site.archived ? (
        <span className="badge badge-sm badge-ghost">Archived</span>
      ) : site.restricted ? (
        <RestrictedBadge size={site.audienceSize} groups={site.audienceGroups} />
      ) : (
        <VisibilityBadge visibility={site.visibility} />
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
