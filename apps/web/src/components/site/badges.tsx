/** The badges a site wears in the list and on its page: visibility (or archived) and share link. */
import type { Site } from '@fling/shared'
import { GlobeAltIcon, LinkIcon, LockClosedIcon } from '@heroicons/react/24/outline'
import { useInstance } from '../../hooks/instance'
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

/** Archived, or the visibility; plus "Shared" while a live site has a share link. */
export function SiteBadges({ site }: { site: Site }) {
  return (
    <>
      {site.archived ? (
        <span className="badge badge-sm badge-ghost">Archived</span>
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
