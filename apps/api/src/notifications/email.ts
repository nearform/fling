/**
 * The email channel: renders a batch with TEMPLATES (one section per event key, in catalogue
 * order) and the instance's branding, and sends it through the Mailer port (`deps.mailer`). The
 * sender is MAIL_FROM with MAIL_FROM_NAME; Reply-To is MAIL_REPLY_TO or none, never the actor.
 * Every message carries the RFC 8058 one-click unsubscribe headers for its first event, and a
 * link per event in its footer.
 */
import {
  EVENT_CATALOGUE,
  type EventKey,
  eventDefinition,
  NOTIFICATION_SETTINGS_PATH,
} from '@fling/shared'
import { instanceMetadata } from '../instance.ts'
import type { Deps } from '../types.ts'
import type { AnyDeliveryItem, Channel, DeliveryBatch, DeliveryItem } from './channel.ts'
import { TEMPLATES } from './templates/index.ts'
import { type RenderedEmail, renderEmail } from './templates/layout.ts'
import type { Section, Template, TemplateContext } from './templates/types.ts'
import { unsubscribeUrl } from './unsubscribe.ts'

const ORDER = new Map(EVENT_CATALOGUE.map((e, i) => [e.key, i]))

/** The batch as an email: subject, text and HTML, and the unsubscribe URL of its first event. */
export function renderBatchEmail(
  deps: Pick<Deps, 'config'>,
  batch: DeliveryBatch
): RenderedEmail & { unsubscribe: string; keys: EventKey[] } {
  const metadata = instanceMetadata(deps.config as Deps['config'])
  const byKey = new Map<EventKey, AnyDeliveryItem[]>()
  for (const item of batch.items) byKey.set(item.key, [...(byKey.get(item.key) ?? []), item])
  const keys = [...byKey.keys()].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0))
  const ctx: TemplateContext = {
    instance: metadata.name,
    appOrigin: metadata.appOrigin,
    to: batch.to,
    site: batch.site,
  }
  const sections: Section[] = keys.map(key => {
    const template = TEMPLATES[key].email as Template<EventKey>
    return template(byKey.get(key) as DeliveryItem<EventKey>[], ctx)
  })
  const subject =
    sections.length === 1
      ? (sections[0] as Section).subject
      : batch.site
        ? `${batch.items.length} updates on ${batch.site.name}`
        : `${batch.items.length} updates`
  const links = keys.map(key => ({
    title: eventDefinition(key).title,
    url: unsubscribeUrl(deps.config, { email: batch.to, event: key, channel: 'email' }),
  }))
  const rendered = renderEmail(metadata, sections, subject, {
    to: batch.to,
    signIn: metadata.auth.displayName,
    unsubscribe: links,
    settingsUrl: `${metadata.appOrigin}${NOTIFICATION_SETTINGS_PATH}`,
    commentNote: keys.some(k => eventDefinition(k).section === 'comments'),
  })
  return { ...rendered, unsubscribe: (links[0] as { url: string }).url, keys }
}

export const emailChannel: Channel = {
  id: 'email',
  async deliver(batch, deps) {
    const mail = deps.config.mail
    if (!mail || !deps.mailer) {
      return { ok: false, retry: false, reason: 'rejected', detail: 'no mailer' }
    }
    const email = renderBatchEmail(deps, batch)
    const result = await deps.mailer.send({
      to: batch.to,
      from: { address: mail.from, name: mail.fromName },
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: {
        'List-Unsubscribe': `<${email.unsubscribe}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      batchId: batch.id,
      tags: email.keys,
    })
    return result.ok ? { ...result, subject: email.subject } : result
  },
}
