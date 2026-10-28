/**
 * Who hears about an event, worked out when it fans out (so group members are read then), never
 * the actor, sorted by address so a resumed fan-out carries on where it stopped. Each recipient
 * gets the data their pending notification keeps (the group that reached them, the comment).
 *
 * One email per recipient per cause: an address the audience names directly hears of an audience
 * change as `site.shared`, never also as `site.shared_via_group`; a member of several added groups
 * hears once. Replies go to the thread's author and everyone who replied before, not to the site's
 * owner as such, so an owner in the thread gets `comment.reply` only.
 */
import type { NotificationEventRecord } from '../store/types.ts'
import type { Deps } from '../types.ts'
import type { CommentEventData, EventData } from './notify.ts'

export interface Recipient {
  email: string
  /** kept on the pending notification, for the send-time checks and the email */
  data: Record<string, unknown>
}

const byEmail = (a: Recipient, b: Recipient) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0)

export async function recipientsOf(
  deps: Deps,
  event: NotificationEventRecord
): Promise<Recipient[]> {
  const out = new Map<string, Recipient>()
  const add = (email: string, data: Record<string, unknown>) => {
    if (email !== event.actor && email.includes('@') && !out.has(email)) {
      out.set(email, { email, data })
    }
  }
  switch (event.key) {
    case 'site.shared': {
      const data = event.data as unknown as EventData['site.shared']
      for (const email of data.emails) add(email, { siteName: data.siteName })
      break
    }
    case 'site.shared_via_group': {
      const data = event.data as unknown as EventData['site.shared_via_group']
      const already = new Set(data.direct)
      for (const id of data.kept) {
        for (const email of await deps.store.listGroupMembers(id)) already.add(email)
      }
      for (const groupId of [...data.groups].sort()) {
        for (const email of await deps.store.listGroupMembers(groupId)) {
          if (!already.has(email)) add(email, { siteName: data.siteName, groupId })
        }
      }
      break
    }
    case 'group.member_added': {
      const data = event.data as unknown as EventData['group.member_added']
      for (const email of data.emails) add(email, { groupId: data.groupId })
      break
    }
    case 'comment.created': {
      const data = event.data as unknown as CommentEventData
      const site = await deps.store.findSite(data.siteName)
      if (site?.id === event.siteId) add(site.email, { ...data })
      break
    }
    case 'comment.reply': {
      const data = event.data as unknown as CommentEventData
      if (!event.siteId) break
      const comments = await deps.store.listComments(event.siteId)
      const thread = comments.find(c => c.id === data.threadId)
      if (!thread) break
      const before = comments.filter(c => c.parentId === data.threadId && c.id < data.commentId)
      for (const c of [thread, ...before]) {
        if (c.author.kind === 'user') add(c.author.email, { ...data })
      }
      break
    }
  }
  return [...out.values()].sort(byEmail)
}
