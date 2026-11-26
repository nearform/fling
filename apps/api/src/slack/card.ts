/**
 * Previews in Slack (Block Kit), short and wide. `siteCard`, a site's: its home page's title linked
 * to its review page (with comments on; else the address posted), who can open it, when it was last
 * published and by whom, links to review and open it, and its thumbnail small beside them.
 * `linkCard`, for a link whose poster can't open it (or that names no site): only what its address
 * shows. Pure: unfurl.ts reads what they show.
 *
 * Everyone in the channel sees the card, so it says who can open the site in the third person
 * ("Only its owners"), never as the poster sees it ("Only you").
 */
import { type AccessLevel, reviewUrl } from '@fling/shared'
import type { Config } from '../config.ts'
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
  /** comments are on: the title and the first link go to its review page */
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

/**
 * Short and wide: one section, the title on the first line, who can open it and when it was
 * published on the second, the links on the third, and the thumbnail small beside them.
 */
export function siteCard(card: SiteCard): SlackUnfurl {
  const title = card.title?.trim() || card.name
  const published = `Published ${slackDate(card.publishedAt)}${
    card.publishedBy ? ` by ${mrkdwn(card.publishedBy)}` : ''
  }`
  // Review is where a link in a conversation leads, where the instance has it; else the site.
  const review = card.review ? reviewUrl(card.appOrigin, card.name) : null
  const links = [...(review ? [`<${review}|Review>`] : []), `<${card.siteUrl}|Open>`].join(' · ')
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*<${review ?? card.url}|${mrkdwn(title)}>*`,
            `${accessText(card.access, mrkdwn(card.instanceName))} · ${published}`,
            links,
          ].join('\n'),
        },
        ...(card.imageUrl
          ? {
              accessory: {
                type: 'image',
                image_url: card.imageUrl,
                alt_text: `The home page of ${card.name}`,
              },
            }
          : {}),
      },
    ],
  }
}

/**
 * The neutral card: the site's name as the address gives it (or, for a page that names no site,
 * the instance's name), linked to the address. It reads the same whether the site exists or not.
 */
export function linkCard(
  config: Pick<Config, 'instanceName'>,
  url: string,
  name: string | null
): SlackUnfurl {
  const instance = mrkdwn(config.instanceName)
  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: name
            ? `*<${url}|${mrkdwn(name)}>*\nA site on ${instance}`
            : `*<${url}|${instance}>*`,
        },
      },
    ],
  }
}
