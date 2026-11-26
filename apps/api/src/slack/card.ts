/**
 * A site's preview in Slack (Block Kit): its home page's title linked to the address posted, its
 * home page's thumbnail, who can open it, when it was last published and by whom, and buttons to
 * open it, review it (with comments on) and see it in the app. Pure: unfurl.ts reads what it shows.
 *
 * Everyone in the channel sees the card, so it says who can open the site in the third person
 * ("Only its owners"), never as the poster sees it ("Only you").
 */
import { type AccessLevel, reviewUrl } from '@fling/shared'
import type { SlackUnfurl } from './client.ts'

export interface SiteCard {
  name: string
  /** the link as posted (a page of the site, or its review or site page on the app) */
  url: string
  /** the site's own address */
  siteUrl: string
  appOrigin: string
  instanceName: string
  /** the current version's home page title */
  title?: string
  access: AccessLevel
  /** when the current version was published */
  publishedAt: string
  /** who published it: their name, or their address */
  publishedBy?: string
  /** a URL Slack can fetch the thumbnail from (presigned) */
  imageUrl?: string
  /** comments are on: the Review button */
  review: boolean
}

function accessText(access: AccessLevel, instanceName: string): string {
  switch (access) {
    case 'only_me':
      return 'Only its owners can open it'
    case 'members':
      return `Everyone signed in to ${instanceName} can open it`
    case 'groups':
      return 'Only the teams it names can open it'
    case 'people':
      return 'Only the people it names can open it'
    case 'public':
      return 'Anyone can open it'
  }
}

/** Slack's mrkdwn, with its three control characters escaped. */
const mrkdwn = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Slack's date token: shown in each reader's own time zone, with the ISO date as its fallback. */
function slackDate(iso: string): string {
  const seconds = Math.floor(Date.parse(iso) / 1000)
  return `<!date^${seconds}^{date_short_pretty} at {time}|${iso}>`
}

const button = (text: string, url: string, actionId: string, primary = false) => ({
  type: 'button',
  text: { type: 'plain_text', text },
  url,
  action_id: actionId,
  ...(primary ? { style: 'primary' } : {}),
})

export function siteCard(card: SiteCard): SlackUnfurl {
  const title = card.title?.trim() || card.name
  const published = `Published ${slackDate(card.publishedAt)}${
    card.publishedBy ? ` by ${mrkdwn(card.publishedBy)}` : ''
  }`
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${card.url}|${mrkdwn(title)}>*\n\`${mrkdwn(card.name)}\` on ${mrkdwn(card.instanceName)}`,
      },
    },
  ]
  if (card.imageUrl) {
    blocks.push({
      type: 'image',
      image_url: card.imageUrl,
      alt_text: `The home page of ${card.name}`,
    })
  }
  blocks.push(
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${accessText(card.access, mrkdwn(card.instanceName))} · ${published}`,
        },
      ],
    },
    {
      type: 'actions',
      elements: [
        button('Open', card.siteUrl, 'fling_open', true),
        ...(card.review
          ? [button('Review', reviewUrl(card.appOrigin, card.name), 'fling_review')]
          : []),
        button(
          'Details',
          `${card.appOrigin.replace(/\/+$/, '')}/sites/${encodeURIComponent(card.name)}`,
          'fling_details'
        ),
      ],
    }
  )
  return { blocks }
}
