/**
 * The badges a site wears in the list and on its page: visibility (or archived), who it is
 * restricted to, and share link.
 */
import type { Site } from '@fling/shared'
import { GlobeAltIcon, LinkIcon, LockClosedIcon, UserGroupIcon } from '@heroicons/react/24/outline'
import { useInstance } from '../../hooks/instance'
import { peopleLabel, restrictedLabel } from '../../lib/audience'
import { audienceFor } from '../../lib/instance'

export function VisibilityBadge({ visibility }: { visibility: Site['visibility'] }) {
  const audience = audienceFor(useInstance())
  return visibility === 'public' ? (
    <span className="badge badge-sm tone-info gap-1" title="Anyone with the URL can open it">
      <GlobeAltIcon className="h-3 w-3" /> Public
    </span>
  ) : (
    <span className="badge badge-sm tone-primary gap-1" title={`Private: open to ${audience}`}>
      <LockClosedIcon className="h-3 w-3" /> Sign-in required
    </span>
  )
}

/** A private site limited to its audience: "Restricted · 3 people". */
export function RestrictedBadge({ size }: { size: number }) {
  return (
    <span
      className="badge badge-sm tone-primary gap-1"
      title={`Only you and ${peopleLabel(size)} can open it`}
    >
      <UserGroupIcon className="h-3 w-3" aria-hidden /> {restrictedLabel(size)}
    </span>
  )
}

/**
 * Archived, or the visibility (and, restricted, to how many); plus "Shared" while a live site
 * has a share link.
 */
export function SiteBadges({ site }: { site: Site }) {
  return (
    <>
      {site.archived ? (
        <span className="badge badge-sm badge-ghost">Archived</span>
      ) : (
        <VisibilityBadge visibility={site.visibility} />
      )}
      {site.restricted && !site.archived && <RestrictedBadge size={site.audienceSize} />}
      {site.shareUrl && !site.archived && (
        <span className="badge badge-sm badge-ghost gap-1" title="Has a share link">
          <LinkIcon className="h-3 w-3" aria-hidden />
          Shared
        </span>
      )}
    </>
  )
}
