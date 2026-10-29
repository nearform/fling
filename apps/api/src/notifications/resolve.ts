/**
 * The send-time checks (design §9), and what survives them as delivery items. For each pending
 * notification of a batch, as of now:
 *
 * - the event's capability is still on (comments), and the recipient's preferences want it on
 *   this channel (`effectivePreference`);
 * - policy still lets the recipient, as a user with their memberships loaded (a guest as one), see what the email
 *   is about: `site.view` for shares, `comment.read` for comments, and the group still holds them
 *   for group events. A site that is gone or archived, a narrowed audience, a group they left, a
 *   deleted comment or thread: the item is dropped. This is the one guarantee that an email never
 *   reveals a site to someone who cannot see it.
 *
 * Standing (the email policy, or a live invitation) and suppression are about the address, not
 * the item: drain.ts checks them per batch.
 */
import {
  type ChannelId,
  effectivePreference,
  eventDefinition,
  type NotificationPreferences,
  reviewUrl,
} from '@fling/shared'
import { instanceMetadata } from '../instance.ts'
import { type Actor, can } from '../policy.ts'
import type { GroupRecord, PendingNotificationRecord, SiteRecord } from '../store/types.ts'
import type { Deps } from '../types.ts'
import type { ActorView, AnyDeliveryItem, CommentView, GroupView, SiteView } from './channel.ts'

/** A comment excerpt's length, in characters. */
export const EXCERPT_CHARS = 300

/** How many of the sites a group opens a `group.member_added` email lists. */
const GROUP_SITES_MAX = 10
/** How many of a group's sites are checked for that list (each one is read and asked of policy). */
const GROUP_SITES_READ = 50

/** What one batch's checks read once and share. */
export class Resolver {
  private readonly sites = new Map<string, Promise<SiteRecord | null>>()
  private readonly groups = new Map<string, Promise<GroupRecord | null>>()
  private readonly actors = new Map<string, Promise<ActorView>>()
  private readonly recipient: Actor
  private readonly capabilities: Record<string, boolean>

  constructor(
    private readonly deps: Deps,
    private readonly email: string,
    private readonly memberships: readonly string[],
    private readonly prefs: NotificationPreferences | null,
    private readonly channel: ChannelId,
    guest = false
  ) {
    this.recipient = {
      kind: 'user',
      email,
      groups: memberships,
      ...(guest ? { guest: true as const } : {}),
    }
    this.capabilities = instanceMetadata(deps.config).capabilities
  }

  private site(siteId: string | null, name: unknown): Promise<SiteRecord | null> {
    if (!siteId || typeof name !== 'string') return Promise.resolve(null)
    let found = this.sites.get(siteId)
    if (!found) {
      found = this.deps.store
        .findSite(name)
        .then(s => (s && s.id === siteId && !s.archived ? s : null))
      this.sites.set(siteId, found)
    }
    return found
  }

  private group(id: unknown): Promise<GroupRecord | null> {
    if (typeof id !== 'string') return Promise.resolve(null)
    let found = this.groups.get(id)
    if (!found) {
      found = this.deps.store.getGroups([id]).then(g => g[0] ?? null)
      this.groups.set(id, found)
    }
    return found
  }

  private actor(actor: string): Promise<ActorView> {
    let found = this.actors.get(actor)
    if (!found) {
      found = actor.includes('@')
        ? this.deps.store
            .getUser(actor)
            .then(u => ({ kind: 'user' as const, email: actor, name: u?.name || actor }))
        : Promise.resolve({ kind: 'guest' as const })
      this.actors.set(actor, found)
    }
    return found
  }

  private siteView(site: SiteRecord): SiteView {
    return { name: site.name, url: reviewUrl(this.deps.config.appOrigin, site.name) }
  }

  private groupView(group: GroupRecord): GroupView {
    return {
      name: group.name,
      slug: group.slug,
      url: `${this.deps.config.appOrigin}/groups/${encodeURIComponent(group.slug)}`,
    }
  }

  /** The item to deliver, or null when it is to be dropped. */
  async resolve(item: PendingNotificationRecord): Promise<AnyDeliveryItem | null> {
    const def = eventDefinition(item.key)
    if (def.capability && this.capabilities[def.capability] !== true) return null
    if (effectivePreference(this.prefs, item.key, this.channel) !== 'on') return null
    const data = item.data ?? {}
    const actor = await this.actor(item.actor)
    const base = { eventId: item.eventId, actor }
    switch (item.key) {
      case 'site.shared': {
        const site = await this.site(item.siteId, data.siteName)
        if (!site || !can(this.recipient, 'site.view', site)) return null
        return { ...base, key: item.key, details: { site: this.siteView(site) } }
      }
      case 'site.shared_via_group': {
        const [site, group] = await Promise.all([
          this.site(item.siteId, data.siteName),
          this.group(data.groupId),
        ])
        if (!site || !group || !this.memberships.includes(group.id)) return null
        if (!site.audience.groups.includes(group.id)) return null
        if (!can(this.recipient, 'site.view', site)) return null
        return {
          ...base,
          key: item.key,
          details: { site: this.siteView(site), group: this.groupView(group) },
        }
      }
      case 'group.member_added': {
        const group = await this.group(data.groupId)
        if (!group || !this.memberships.includes(group.id)) return null
        const { sites, more } = await this.groupSites(group.id)
        return {
          ...base,
          key: item.key,
          details: { group: this.groupView(group), sites, moreSites: more },
        }
      }
      case 'comment.created':
      case 'comment.reply': {
        const site = await this.site(item.siteId, data.siteName)
        if (!site || !can(this.recipient, 'comment.read', site)) return null
        const comment = await this.comment(site, data)
        if (!comment) return null
        return { ...base, key: item.key, details: { site: this.siteView(site), comment } }
      }
    }
  }

  private async comment(
    site: SiteRecord,
    data: Record<string, unknown>
  ): Promise<CommentView | null> {
    const { commentId, threadId } = data
    if (typeof commentId !== 'string' || typeof threadId !== 'string') return null
    const [comment, thread] = await Promise.all([
      this.deps.store.getComment(site.id, commentId),
      threadId === commentId ? null : this.deps.store.getComment(site.id, threadId),
    ])
    if (!comment || (threadId !== commentId && !thread)) return null
    const guest = comment.author.kind !== 'user'
    const url = `${reviewUrl(this.deps.config.appOrigin, site.name, comment.path)}${comment.path === '/' ? '?' : '&'}thread=${encodeURIComponent(threadId)}`
    return {
      id: comment.id,
      threadId,
      path: comment.path,
      url,
      excerpt: guest ? null : excerptOf(comment.body),
    }
  }

  /** The sites the group opens to the recipient that they can see: some, and how many more. */
  private async groupSites(groupId: string): Promise<{ sites: SiteView[]; more: number }> {
    const items = await this.deps.store.listGroupSites(groupId)
    const visible: SiteView[] = []
    const sorted = items.sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, GROUP_SITES_READ)
    for (const item of sorted) {
      const site = await this.site(item.siteId, item.name)
      if (site?.currentVersionId && can(this.recipient, 'site.view', site)) {
        visible.push(this.siteView(site))
      }
    }
    return {
      sites: visible.slice(0, GROUP_SITES_MAX),
      more: Math.max(0, visible.length - GROUP_SITES_MAX),
    }
  }
}

/** A comment body as an excerpt: one paragraph of plain text, cut to EXCERPT_CHARS. */
export function excerptOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`
}
