/**
 * `notify`: how an action tells the hub that something happened. Called in the request, after the
 * action's own writes, it records the event and its fan-out marker (one transaction, two items)
 * and nothing more: it never sends, never waits on a provider, and never fails the action (an
 * error is logged, without addresses, and swallowed). The drainer (drain.ts) does the rest.
 *
 * Event ids are derived from the cause (`comment.created:<siteId>:<commentId>`,
 * `site.shared:<siteId>:<site updatedAt>`, `group.member_added:<groupId>:<group updatedAt>`), so a
 * retried request records the event once.
 *
 * Nothing is recorded on an instance without a notifications channel, for an event whose
 * capability is off, or while an admin impersonates the actor: notifications are the user's, and
 * nothing done in an impersonated session may outlive it.
 *
 * The helpers below are what the actions call (sites.ts `updateSite`, groups.ts, comments.ts):
 * they name only what changed, so saving the same audience or group again notifies nobody.
 */
import { type EventKey, eventDefinition } from '@fling/shared'
import { instanceMetadata, notificationChannels } from '../instance.ts'
import { type CommentRecord, minuteOf, type SiteAudience, type SiteRecord } from '../store/types.ts'
import type { Deps } from '../types.ts'
import { errorName, logNotify } from './log.ts'

/** What each event records for the drainer: enough to find its recipients and render it. */
export interface EventData {
  /** `emails`: the addresses this change added */
  'site.shared': { siteName: string; emails: string[] }
  /**
   * `groups`: the groups this change added; `direct`: every address the audience names (they hear
   * of it as `site.shared`, or could see the site already); `kept`: groups it named before
   */
  'site.shared_via_group': {
    siteName: string
    groups: string[]
    direct: string[]
    kept: string[]
  }
  /** `emails`: the members this change added */
  'group.member_added': { groupId: string; emails: string[] }
  'comment.created': CommentEventData
  'comment.reply': CommentEventData
}

export interface CommentEventData {
  siteName: string
  commentId: string
  /** the thread: the comment itself for a new thread, its parent for a reply */
  threadId: string
  path: string
  /** written by a guest (no address, unverified): no name or excerpt in the email */
  guest: boolean
}

/** An event as an action reports it. */
export type NewEvent = {
  [K in EventKey]: {
    key: K
    /** what makes the id: the same cause, the same event */
    cause: string
    /** the address of who did it (`guest` for a guest), never told about it */
    actor: string
    siteId: string | null
    data: EventData[K]
  }
}[EventKey]

/** Who is acting in this request, beyond the user: an admin impersonating them. */
export interface Acting {
  impersonator?: string
}

/** The `Acting` of a request's principal (policy.ts). */
export const actingOf = (p: { impersonator?: string }): Acting =>
  p.impersonator === undefined ? {} : { impersonator: p.impersonator }

export const eventIdOf = (event: Pick<NewEvent, 'key' | 'cause'>) => `${event.key}:${event.cause}`

/** Record the event for the drainer. Never throws. */
export async function notify(deps: Deps, event: NewEvent, acting: Acting = {}): Promise<void> {
  try {
    if (notificationChannels(deps.config).length === 0) return
    if (acting.impersonator !== undefined) return
    const capability = eventDefinition(event.key).capability
    if (capability && instanceMetadata(deps.config).capabilities[capability] !== true) return
    const now = deps.clock.now()
    await deps.store.putNotificationEvent(
      {
        id: eventIdOf(event),
        key: event.key,
        actor: event.actor,
        siteId: event.siteId,
        data: event.data as unknown as Record<string, unknown>,
        createdAt: now.toISOString(),
      },
      minuteOf(now)
    )
  } catch (err) {
    logNotify('error', 'notify failed', { event: event.key, err: errorName(err) })
  }
}

const added = (after: readonly string[], before: readonly string[]) => {
  const had = new Set(before)
  return after.filter(x => !had.has(x))
}

/**
 * The owner saved the site's audience (already written, so `site.updatedAt` is this change's):
 * `site.shared` for the addresses it added, `site.shared_via_group` for the groups.
 */
export async function notifyAudienceChange(
  deps: Deps,
  owner: string,
  site: SiteRecord,
  before: SiteAudience,
  acting: Acting = {}
) {
  const emails = added(site.audience.emails, before.emails)
  const groups = added(site.audience.groups, before.groups)
  const cause = `${site.id}:${site.updatedAt}`
  if (emails.length > 0) {
    await notify(
      deps,
      {
        key: 'site.shared',
        cause,
        actor: owner,
        siteId: site.id,
        data: { siteName: site.name, emails },
      },
      acting
    )
  }
  if (groups.length > 0) {
    await notify(
      deps,
      {
        key: 'site.shared_via_group',
        cause,
        actor: owner,
        siteId: site.id,
        data: {
          siteName: site.name,
          groups,
          direct: [...site.audience.emails],
          kept: site.audience.groups.filter(g => before.groups.includes(g)),
        },
      },
      acting
    )
  }
}

/** The group's owner added people (already written, so `updatedAt` is this change's). */
export async function notifyMembersAdded(
  deps: Deps,
  owner: string,
  group: { id: string; updatedAt: string },
  emails: readonly string[],
  acting: Acting = {}
) {
  if (emails.length === 0) return
  await notify(
    deps,
    {
      key: 'group.member_added',
      cause: `${group.id}:${group.updatedAt}`,
      actor: owner,
      siteId: null,
      data: { groupId: group.id, emails: [...emails] },
    },
    acting
  )
}

/** A comment was added: a new thread (`comment.created`) or a reply (`comment.reply`). */
export async function notifyComment(
  deps: Deps,
  site: SiteRecord,
  comment: CommentRecord,
  acting: Acting = {}
) {
  const guest = comment.author.kind !== 'user'
  const actor = comment.author.kind === 'user' ? comment.author.email : 'guest'
  const data: CommentEventData = {
    siteName: site.name,
    commentId: comment.id,
    threadId: comment.parentId ?? comment.id,
    path: comment.path,
    guest,
  }
  const cause = `${site.id}:${comment.id}`
  await notify(
    deps,
    comment.parentId === null
      ? { key: 'comment.created', cause, actor, siteId: site.id, data }
      : { key: 'comment.reply', cause, actor, siteId: site.id, data },
    acting
  )
}
