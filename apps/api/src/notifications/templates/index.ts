/**
 * TEMPLATES: what each event says, per channel, folded (several of the same event in one
 * message: "Ben and Ana left 4 comments on q3-report"). Plain text in, plain text out: the layout
 * escapes. A share's message to someone invited from outside who has never signed in
 * (`ctx.invitation`) says they were invited, and its button is their sign-in link. A guest's comment carries neither a name, an excerpt nor its page path (design §9): it is
 * unverified, and mail clients may turn a URL in it into a link.
 */
import type { ActorView, DeliveryItem, SiteView } from '../channel.ts'
import { lifetimeInWords } from './sign-in-link.ts'
import type { Section, TemplateContext, Templates } from './types.ts'

export type { Section, Template, TemplateContext, Templates } from './types.ts'

/** How many excerpts or links a section lists before "and N more". */
const LIST_MAX = 10

/** One person as a lead names them: their name, and their address when it differs. */
function fullName(actor: ActorView): string {
  if (actor.kind === 'guest') return 'A guest'
  return actor.name && actor.name !== actor.email ? `${actor.name} (${actor.email})` : actor.email
}

function shortName(actor: ActorView): string {
  return actor.kind === 'guest' ? 'a guest' : actor.name || actor.email
}

/**
 * Who did it, for a folded section: one person by name and address; else "Ben and Ana",
 * "Ben, Ana and Cy", "Ben, Ana and 2 others". Guests count as one ("guests"). Short (`full` false): one person by name only, for subjects.
 */
export function actorsPhrase(actors: readonly ActorView[], full = true): string {
  const users = new Map<string, ActorView>()
  let guests = 0
  for (const a of actors) {
    if (a.kind === 'guest') guests++
    else if (!users.has(a.email)) users.set(a.email, a)
  }
  const named = [...users.values()]
  if (named.length === 1 && guests === 0) {
    const one = named[0] as ActorView
    return full ? fullName(one) : shortName(one)
  }
  if (named.length === 0) return guests === 1 ? 'A guest' : 'Guests'
  const parts = named.map(shortName)
  if (guests > 0) parts.push(guests === 1 ? 'a guest' : 'guests')
  if (parts.length > 3) return `${parts.slice(0, 2).join(', ')} and ${parts.length - 2} others`
  return parts.length === 1
    ? (parts[0] as string)
    : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** ", on /docs/": the comment's page, unless a guest wrote it (a path is text they chose). */
const onPage = (item: DeliveryItem<'comment.created' | 'comment.reply'>) => {
  const { path } = item.details.comment
  return item.actor.kind === 'guest' || path === '/' ? '' : `, on ${path}`
}

function moreLine(total: number, what: string): string[] {
  return total > LIST_MAX ? [`And ${total - LIST_MAX} more ${what}.`] : []
}

function siteLinks(sites: SiteView[]) {
  return sites.slice(0, LIST_MAX).map(s => ({ text: s.name, url: s.url }))
}

function commentQuotes(items: DeliveryItem<'comment.created' | 'comment.reply'>[]) {
  return items
    .filter(i => i.details.comment.excerpt !== null)
    .slice(0, LIST_MAX)
    .map(i => ({
      by: i.actor.kind === 'user' ? shortName(i.actor) : null,
      text: i.details.comment.excerpt as string,
      url: i.details.comment.url,
    }))
}

/** One person, unnamed guests, or several: whether a section's actors are only guests. */
const onlyGuests = (items: DeliveryItem[]) => items.every(i => i.actor.kind === 'guest')

/**
 * The section as an invited newcomer gets it (`ctx.invitation`): that they were invited (as a
 * reviewer, for a guest), and a button that signs them in, once, and goes on where it led.
 */
function invitedTo(section: Section, ctx: TemplateContext): Section {
  const invitation = ctx.invitation
  if (!invitation) return section
  const label = section.action.label
  return {
    ...section,
    lines: [
      invitation.guest
        ? `You've been invited to ${ctx.instance} as a reviewer: you can open and comment on what is shared with you.`
        : `You've been invited to ${ctx.instance}.`,
      ...(section.lines ?? []),
      `The button signs you in as ${ctx.to}. It works once, within ${lifetimeInWords(invitation.ttlSeconds)}; after that, ask for a new link on the sign-in page.`,
    ],
    action: {
      label: `Sign in and ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
      url: invitation.url,
    },
  }
}

const siteShared = (items: DeliveryItem<'site.shared'>[], ctx: TemplateContext): Section =>
  invitedTo(siteSharedSection(items, ctx), ctx)

const siteSharedSection = (items: DeliveryItem<'site.shared'>[], ctx: TemplateContext): Section => {
  const who = actorsPhrase(items.map(i => i.actor))
  const sites = items.map(i => i.details.site)
  const first = sites[0] as SiteView
  if (sites.length === 1) {
    return {
      subject: `${actorsPhrase(
        items.map(i => i.actor),
        false
      )} shared ${first.name} with you`,
      lead: `${who} shared ${first.name} with you on ${ctx.instance}.`,
      action: { label: `Open ${first.name}`, url: first.url },
      why: `${who} shared a site with you on ${ctx.instance}`,
    }
  }
  return {
    subject: `${plural(sites.length, 'site')} shared with you`,
    lead: `${who} shared ${plural(sites.length, 'site')} with you on ${ctx.instance}:`,
    links: siteLinks(sites),
    lines: moreLine(sites.length, 'sites'),
    action: { label: `Open ${ctx.instance}`, url: ctx.appOrigin },
    why: `sites were shared with you on ${ctx.instance}`,
  }
}

const siteSharedViaGroup = (
  items: DeliveryItem<'site.shared_via_group'>[],
  ctx: TemplateContext
): Section => invitedTo(siteSharedViaGroupSection(items, ctx), ctx)

const siteSharedViaGroupSection = (
  items: DeliveryItem<'site.shared_via_group'>[],
  ctx: TemplateContext
): Section => {
  const who = actorsPhrase(items.map(i => i.actor))
  const first = items[0] as DeliveryItem<'site.shared_via_group'>
  const { site, group } = first.details
  if (items.length === 1) {
    return {
      subject: `${site.name} was shared with ${group.name}`,
      lead: `${who} shared ${site.name} with ${group.name}, which you are in.`,
      action: { label: `Open ${site.name}`, url: site.url },
      why: `${site.name} was shared with a group you are in on ${ctx.instance}`,
    }
  }
  return {
    subject: `${plural(items.length, 'site')} shared with your groups`,
    lead: `${who} shared ${plural(items.length, 'site')} with groups you are in:`,
    links: items.slice(0, LIST_MAX).map(i => ({
      text: `${i.details.site.name} (${i.details.group.name})`,
      url: i.details.site.url,
    })),
    lines: moreLine(items.length, 'sites'),
    action: { label: `Open ${ctx.instance}`, url: ctx.appOrigin },
    why: `sites were shared with groups you are in on ${ctx.instance}`,
  }
}

/** What each role lets its holders do, for the role emails. */
const ROLE_WORDS = {
  'site.owner_added': {
    role: 'an owner',
    does: 'You can publish it, change who can open it and its settings, its owners and publishers, and delete it.',
    doesMany:
      'You can publish them, change who can open them and their settings, their owners and publishers, and delete them.',
  },
  'site.publisher_added': {
    role: 'a publisher',
    does: 'You can publish new versions of it and roll it back.',
    doesMany: 'You can publish new versions of them and roll them back.',
  },
} as const

const roleAdded = <K extends 'site.owner_added' | 'site.publisher_added'>(
  items: DeliveryItem<K>[],
  ctx: TemplateContext
): Section => {
  const key = (items[0] as DeliveryItem<K>).key
  const words = ROLE_WORDS[key]
  const who = actorsPhrase(items.map(i => i.actor))
  const sites = [...new Map(items.map(i => [i.details.site.name, i])).values()]
  if (sites.length === 1) {
    const { site, group } = (sites[0] as DeliveryItem<K>).details
    const via = group ? ` through ${group.name}, which you are in` : ''
    return {
      subject: `You are now ${words.role} of ${site.name}`,
      lead: `${who} made you ${words.role} of ${site.name}${via} on ${ctx.instance}.`,
      lines: [words.does],
      action: { label: `Open ${site.name}`, url: site.url },
      why: `you were made ${words.role} of a site on ${ctx.instance}`,
    }
  }
  return {
    subject: `You are now ${words.role} of ${plural(sites.length, 'site')}`,
    lead: `${who} made you ${words.role} of ${plural(sites.length, 'site')} on ${ctx.instance}:`,
    links: siteLinks(sites.map(i => i.details.site)),
    lines: [...moreLine(sites.length, 'sites'), words.doesMany],
    action: { label: `Open ${ctx.instance}`, url: ctx.appOrigin },
    why: `you were made ${words.role} of sites on ${ctx.instance}`,
  }
}

const groupMemberAdded = (
  items: DeliveryItem<'group.member_added'>[],
  ctx: TemplateContext
): Section => invitedTo(groupMemberAddedSection(items, ctx), ctx)

const groupMemberAddedSection = (
  items: DeliveryItem<'group.member_added'>[],
  ctx: TemplateContext
): Section => {
  const who = actorsPhrase(items.map(i => i.actor))
  const groups = [...new Map(items.map(i => [i.details.group.slug, i])).values()]
  const sites = [...new Map(groups.flatMap(i => i.details.sites).map(s => [s.name, s])).values()]
  const more = groups.reduce((n, i) => n + i.details.moreSites, 0)
  const opens =
    sites.length > 0
      ? {
          lines: [
            `${groups.length === 1 ? 'It opens' : 'They open'} these sites to you:`,
            ...moreLine(sites.length, 'sites'),
            ...(more > 0 ? [`And ${plural(more, 'other site')}.`] : []),
          ],
          links: siteLinks(sites),
        }
      : {}
  if (groups.length === 1) {
    const { group } = (groups[0] as DeliveryItem<'group.member_added'>).details
    return {
      subject: `You were added to ${group.name}`,
      lead: `${who} added you to ${group.name} on ${ctx.instance}.`,
      ...opens,
      action: { label: `Open ${group.name}`, url: group.url },
      why: `${who} added you to a group on ${ctx.instance}`,
    }
  }
  return {
    subject: `You were added to ${plural(groups.length, 'group')}`,
    lead: `${who} added you to ${groups.map(i => i.details.group.name).join(', ')} on ${ctx.instance}.`,
    ...opens,
    action: { label: 'See your groups', url: `${ctx.appOrigin}/groups` },
    why: `you were added to groups on ${ctx.instance}`,
  }
}

const commentCreated = (
  items: DeliveryItem<'comment.created'>[],
  ctx: TemplateContext
): Section => {
  const who = actorsPhrase(items.map(i => i.actor))
  const first = items[0] as DeliveryItem<'comment.created'>
  const { site, comment } = first.details
  const short = actorsPhrase(
    items.map(i => i.actor),
    false
  )
  if (items.length === 1) {
    return {
      subject: `${short} commented on ${site.name}`,
      lead: `${who} commented on ${site.name}${onPage(first)}${comment.excerpt ? ':' : '.'}`,
      quotes: commentQuotes(items),
      action: { label: 'Open the thread', url: comment.url },
      why: `someone commented on ${site.name}, your site on ${ctx.instance}`,
    }
  }
  return {
    subject: `${short} left ${plural(items.length, 'comment')} on ${site.name}`,
    lead: `${who} left ${plural(items.length, 'comment')} on ${site.name}${onlyGuests(items) ? '.' : ':'}`,
    quotes: commentQuotes(items),
    lines: moreLine(items.filter(i => i.details.comment.excerpt).length, 'comments'),
    action: { label: 'Open the review page', url: site.url },
    why: `people commented on ${site.name}, your site on ${ctx.instance}`,
  }
}

const commentReply = (items: DeliveryItem<'comment.reply'>[], ctx: TemplateContext): Section => {
  const who = actorsPhrase(items.map(i => i.actor))
  const first = items[0] as DeliveryItem<'comment.reply'>
  const { site, comment } = first.details
  const short = actorsPhrase(
    items.map(i => i.actor),
    false
  )
  const threads = new Set(items.map(i => i.details.comment.threadId)).size
  if (items.length === 1) {
    return {
      subject: `${short} replied in a thread on ${site.name}`,
      lead: `${who} replied in a thread on ${site.name}${onPage(first)}${comment.excerpt ? ':' : '.'}`,
      quotes: commentQuotes(items),
      action: { label: 'Open the thread', url: comment.url },
      why: `you took part in a thread on ${site.name} on ${ctx.instance}`,
    }
  }
  return {
    subject: `${short} left ${plural(items.length, 'reply', 'replies')} on ${site.name}`,
    lead: `${who} left ${plural(items.length, 'reply', 'replies')} in ${plural(threads, 'thread')} on ${site.name}${onlyGuests(items) ? '.' : ':'}`,
    quotes: commentQuotes(items),
    lines: moreLine(items.filter(i => i.details.comment.excerpt).length, 'replies'),
    action:
      threads === 1
        ? { label: 'Open the thread', url: comment.url }
        : { label: 'Open the review page', url: site.url },
    why: `you took part in threads on ${site.name} on ${ctx.instance}`,
  }
}

export const TEMPLATES: Templates = {
  'site.shared': { email: siteShared },
  'site.shared_via_group': { email: siteSharedViaGroup },
  'site.owner_added': { email: roleAdded },
  'site.publisher_added': { email: roleAdded },
  'group.member_added': { email: groupMemberAdded },
  'comment.created': { email: commentCreated },
  'comment.reply': { email: commentReply },
}
