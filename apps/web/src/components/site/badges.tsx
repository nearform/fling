/**
 * The badges a site wears in the list and on its page: its access level (or archived), with how
 * many people and teams a list names, whether it has a share link, and Publisher when the user
 * publishes it without owning it. Neutral and muted, so they
 * read as status beside the tinted Review button, never as actions; the icon tells the levels
 * apart. `compact` (the grid's cards) shows the icons alone: the labels stay for screen readers
 * and in the tooltips.
 */
import {
  type AccessLevel,
  accessDescription,
  type Site,
  type SiteAccessFields,
  siteAccessLevel,
} from '@fling/shared'
import {
  GlobeAltIcon,
  LinkIcon,
  LockClosedIcon,
  PaperAirplaneIcon,
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
export function AccessBadge({
  site,
  label,
  compact = false,
}: {
  site: SiteAccessFields
  label?: string
  compact?: boolean
}) {
  const members = audienceFor(useInstance())
  const level = siteAccessLevel(site)
  const Icon = ICONS[level]
  const text = label ?? accessBadgeLabel(site)
  const about = accessDescription(level, members)
  return (
    <span
      className={`badge badge-sm badge-ghost gap-1 text-secondary ${compact ? 'px-1' : ''}`}
      title={compact ? `${text}: ${about}` : about}
    >
      <Icon className="h-3 w-3" aria-hidden /> <Label text={text} compact={compact} />
    </span>
  )
}

/** A badge's words: shown, or for screen readers only on a compact badge. */
function Label({ text, compact }: { text: string; compact: boolean }) {
  return compact ? <span className="sr-only">{text}</span> : <>{text}</>
}

/**
 * The access level (or archived), plus "Shared" while a live site has a share link. `othersSite`:
 * an admin looking at someone else's, where only-me reads "Only its owner".
 */
export function SiteBadges({
  site,
  othersSite = false,
  compact = false,
}: {
  site: Site
  othersSite?: boolean
  compact?: boolean
}) {
  const pad = compact ? 'px-1' : ''
  return (
    <>
      {site.archived ? (
        <span className="badge badge-sm badge-ghost">Archived</span>
      ) : (
        <AccessBadge
          site={site}
          compact={compact}
          {...(othersSite && siteAccessLevel(site) === 'only_me' && { label: 'Only its owner' })}
        />
      )}
      {site.shareUrl && !site.archived && (
        <span className={`badge badge-sm badge-ghost gap-1 ${pad}`} title="Has a share link">
          <LinkIcon className="h-3 w-3" aria-hidden />
          <Label text="Shared" compact={compact} />
        </span>
      )}
      {site.role === 'publisher' && (
        <span
          className={`badge badge-sm badge-ghost gap-1 ${pad}`}
          title={`${compact ? 'Publisher: y' : 'Y'}ou publish this site: its owners manage who can open it and its settings`}
        >
          <PaperAirplaneIcon className="h-3 w-3" aria-hidden />
          <Label text="Publisher" compact={compact} />
        </span>
      )}
    </>
  )
}
