/**
 * What a template is: a function from the folded items of one event (and the context the message
 * goes out in) to a `Section`, plain data the layout (layout.ts) renders as text and as HTML, so
 * escaping happens in one place. A message holds one section per event key it folds.
 */
import type { ChannelId, EventKey } from '@fling/shared'
import type { DeliveryItem, SiteView } from '../channel.ts'

export interface TemplateContext {
  /** the instance's name */
  instance: string
  appOrigin: string
  /** the recipient's address */
  to: string
  /** the site the batch is about, if any */
  site: SiteView | null
}

export interface Section {
  /** the message's subject when it holds only this section (the layout adds the instance) */
  subject: string
  /** the first line: who did what */
  lead: string
  /** more lines of plain text */
  lines?: string[]
  /** comment excerpts, with who wrote them (null: unnamed) */
  quotes?: { by: string | null; text: string; url: string }[]
  /** further links (the sites shared, the sites a group opens) */
  links?: { text: string; url: string }[]
  /** the button */
  action: { label: string; url: string }
  /** why the recipient got it: completes "You got this email because …" */
  why: string
}

export type Template<K extends EventKey> = (
  items: DeliveryItem<K>[],
  ctx: TemplateContext
) => Section

/** Every event's template for every channel: a missing one fails the type check. */
export type Templates = { [K in EventKey]: Record<ChannelId, Template<K>> }
