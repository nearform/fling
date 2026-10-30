/**
 * Channels: the ways a notification reaches someone. A channel is core code that turns one batch
 * (one recipient, one site or none, one or more events folded together) into one message and
 * hands it on: the email channel (email.ts) renders with TEMPLATES and calls the Mailer port.
 *
 * The drainer (drain.ts) resolves every pending notification into a `DeliveryItem` first, after
 * the send-time checks, so a channel only sees what the recipient may know: the site's and group's
 * names, the actor, and a comment excerpt when a signed-in member wrote it.
 */
import type { ChannelId, EventKey } from '@fling/shared'
import type { MailFailureReason } from '../mail/types.ts'
import type { Deps } from '../types.ts'
import { emailChannel } from './email.ts'

/** Who did it, as an email may name them: a user by name and address, or a guest, unnamed. */
export type ActorView = { kind: 'user'; email: string; name: string } | { kind: 'guest' }

/** A site as an email names it: its name and its review page. */
export interface SiteView {
  name: string
  url: string
}

export interface GroupView {
  name: string
  slug: string
  /** the group's page */
  url: string
}

export interface CommentView {
  id: string
  threadId: string
  path: string
  /** the review page at the thread */
  url: string
  /** the first characters of the body; null for a guest's comment */
  excerpt: string | null
}

/** What each event's message is about, resolved at send time. */
export interface EventDetails {
  'site.shared': { site: SiteView }
  'site.shared_via_group': { site: SiteView; group: GroupView }
  /** `site`: the site's page in the app; `group`: the group that made them one, if not directly */
  'site.owner_added': { site: SiteView; group: GroupView | null }
  'site.publisher_added': { site: SiteView; group: GroupView | null }
  /** `sites`: the sites the group opens to the recipient that they can see (some of them) */
  'group.member_added': { group: GroupView; sites: SiteView[]; moreSites: number }
  'comment.created': { site: SiteView; comment: CommentView }
  'comment.reply': { site: SiteView; comment: CommentView }
}

export interface DeliveryItem<K extends EventKey = EventKey> {
  key: K
  eventId: string
  actor: ActorView
  details: EventDetails[K]
}

/** A delivery item of any event, discriminated by `key`. */
export type AnyDeliveryItem = { [K in EventKey]: DeliveryItem<K> }[EventKey]

/**
 * The events whose email carries an invited newcomer's sign-in link (`DeliveryInvitation`):
 * something was shared with them, directly, through a group, or by adding them to one.
 */
export const INVITATION_EVENTS: ReadonlySet<EventKey> = new Set<EventKey>([
  'site.shared',
  'site.shared_via_group',
  'group.member_added',
])

/**
 * A sign-in link for someone invited from outside the email policy who has never signed in (the
 * drainer mints it at send time): the message's button signs them in.
 */
export interface DeliveryInvitation {
  /** the link: it works once */
  url: string
  ttlSeconds: number
  /** invited as a guest (a reviewer), else as a member */
  guest: boolean
}

/** One batch, resolved: one message to one recipient. */
export interface DeliveryBatch {
  /** the batch id: what logs and provider tags name */
  id: string
  to: string
  channel: ChannelId
  /** the site the batch is about, or null (shares and groups) */
  site: SiteView | null
  /** oldest event first; never empty */
  items: AnyDeliveryItem[]
  /** an invited newcomer's sign-in link, on a batch about something shared with them */
  invitation?: DeliveryInvitation
}

export type DeliveryResult =
  | { ok: true; providerId?: string; subject: string }
  | {
      ok: false
      retry: boolean
      reason: MailFailureReason
      /** the provider's daily quota: wait for the next UTC day */
      quota?: boolean
      detail?: string
    }

export interface Channel {
  id: ChannelId
  /** Deliver one batch to one recipient: one message, however many events it folds. */
  deliver(batch: DeliveryBatch, deps: Deps): Promise<DeliveryResult>
}

/** The channels this instance has on: email with a mail driver and its mailer. */
export function channelsOf(deps: Deps): Channel[] {
  return deps.config.mail && deps.mailer ? [emailChannel] : []
}
