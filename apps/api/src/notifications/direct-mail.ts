/**
 * Mail sent at once, straight to the Mailer rather than through the outbox: the admin's test email
 * (mail-admin.ts) and a sign-in link (auth/sign-in-link.ts). One message, one section, branded by
 * the same layout as the hub's emails, with no unsubscribe links: nobody is on a list for these.
 * The caller decides whether to send at all (policy, rate limits, standing); this only sends.
 *
 * Logs name the batch and the recipient's `addressHash`, never the address or the message's links.
 */
import { instanceMetadata } from '../instance.ts'
import { notFound } from '../lib/errors.ts'
import { newSortableId } from '../lib/ids.ts'
import type { MailResult } from '../mail/types.ts'
import type { Deps } from '../types.ts'
import { addressHash, logNotify } from './log.ts'
import { renderEmail } from './templates/layout.ts'
import type { Section } from './templates/types.ts'

export interface DirectMail {
  to: string
  /** what it says; its `subject` is the message's (the layout adds the instance's name) */
  section: Section
  /** the provider tag and the log line's name for it (`mail.test`, `auth.link`) */
  tag: string
}

/** The instance's mail settings and Mailer; 404 when email isn't set up. */
export function mailOf(deps: Deps) {
  if (!deps.config.mail || !deps.mailer) throw notFound('Email is not set up on this instance')
  return { mail: deps.config.mail, mailer: deps.mailer }
}

/** Render and send one message now. Never throws for the provider's refusal: see `result`. */
export async function sendDirectMail(
  deps: Deps,
  message: DirectMail
): Promise<{ result: MailResult; subject: string }> {
  const { mail, mailer } = mailOf(deps)
  const rendered = renderEmail(
    instanceMetadata(deps.config),
    [message.section],
    message.section.subject,
    { to: message.to, unsubscribe: [], commentNote: false }
  )
  const batchId = `${message.tag.replace(/\W+/g, '-')}-${newSortableId(deps.clock.now())}`
  const result = await mailer.send({
    to: message.to,
    from: { address: mail.from, name: mail.fromName },
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    headers: {},
    batchId,
    tags: [message.tag],
  })
  logNotify(result.ok ? 'info' : 'warn', message.tag, {
    batchId,
    to: addressHash(message.to),
    ok: result.ok,
    ...(result.ok ? {} : { reason: result.reason, detail: result.detail }),
  })
  return { result, subject: rendered.subject }
}
