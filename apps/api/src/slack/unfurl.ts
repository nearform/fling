/**
 * Link previews in Slack (`link_shared` events, routes/slack.ts). Once the instance's Slack app
 * claims its domains, Slack makes no preview of their links itself, so every link gets a card from
 * here: the site's card (card.ts `siteCard`) when the person who posted it can open the site, and
 * otherwise a neutral one (`linkCard`) that shows only what the address already does.
 *
 * - **Who posted**: their Slack profile's email (`users.info`), as a Fling user who has signed in
 *   before and still has standing (auth/standing.ts). Admin rights are never applied: a card goes
 *   only where the poster could open the site as a member.
 * - **Which site**: a site's own host (`<name>.<sites domain>`, any page), or its review or site
 *   page on the app (`/review/<name>`, `/sites/<name>`). A share link, or any other page, names
 *   no site, and gets the neutral card.
 * - **What it shows**: whatever the poster's `site.view` lets them see. The card goes to the whole
 *   channel, as a screenshot the poster posted would; opening the site still needs access.
 * - An archived site, or one with nothing live, gets the neutral card. It reads the same whether
 *   the site exists or not, so it tells nobody which names are taken.
 */

import { isValidSiteName, parseLabel, siteLabel, siteUrl } from '@fling/shared'
import { withStanding } from '../auth/standing.ts'
import { can } from '../policy.ts'
import { siteActor } from '../sites.ts'
import { accessOfSite, type SiteRecord } from '../store/types.ts'
import type { Deps } from '../types.ts'
import { linkCard, siteCard } from './card.ts'
import type { SlackClient, SlackUnfurl } from './client.ts'
import { SLACK_BASE } from './config.ts'
import { thumbnailSignature } from './signature.ts'

/** At most this many links of one message get a card (Slack sends up to five). */
export const UNFURL_LINKS_MAX = 5

/** The site a link names, if it names one (see the header). */
export function siteNameOf(deps: Pick<Deps, 'config'>, link: string): string | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  const { sitesDomain, appOrigin } = deps.config
  const suffix = `.${sitesDomain}`
  if (url.host.endsWith(suffix)) {
    const label = parseLabel(url.host.slice(0, -suffix.length))
    return label?.kind === 'site' ? label.name : null
  }
  if (url.origin !== new URL(appOrigin).origin) return null
  const page = /^\/(?:review|sites)\/([^/]+)\/?$/.exec(url.pathname)
  const name = page?.[1] ? decodeURIComponent(page[1]) : null
  return name && isValidSiteName(name) ? name : null
}

/** What `unfurlLinks` did, for the log: counts only, never who posted. */
export interface UnfurlSummary {
  links: number
  /** links that name a site */
  sites: number
  /** the poster is a Fling user with standing */
  poster: boolean
  /** site cards, the rest neutral */
  cards: number
}

/** A card for each link `slackUserId` posted: the site's where they can open it, else neutral. */
export async function unfurlLinks(
  deps: Deps,
  slack: SlackClient,
  slackUserId: string,
  links: string[]
): Promise<{ unfurls: Record<string, SlackUnfurl>; summary: UnfurlSummary }> {
  const posted = links.slice(0, UNFURL_LINKS_MAX).map(url => ({ url, name: siteNameOf(deps, url) }))
  const unfurls: Record<string, SlackUnfurl> = {}
  for (const { url, name } of posted) unfurls[url] = linkCard(deps.config, url, name)
  const named = posted.filter((l): l is { url: string; name: string } => l.name !== null)
  const summary = { links: posted.length, sites: named.length, poster: false, cards: 0 }
  if (!named.length) return { unfurls, summary }

  const email = await slack.userEmail(slackUserId)
  const stored = email ? await deps.store.getUser(email) : null
  // As stored: no `admin`, which only a request's credential carries (auth/standing.ts).
  const user = stored ? await withStanding(deps, stored) : null
  if (!user) return { unfurls, summary }
  summary.poster = true

  await Promise.all(
    named.map(async ({ url, name }) => {
      const site = await deps.store.findSite(name)
      if (!site || site.archived || !site.currentVersionId) return
      if (!can(await siteActor(deps, user, site), 'site.view', site)) return
      unfurls[url] = await cardOf(deps, site, site.currentVersionId, url)
      summary.cards++
    })
  )
  return { unfurls, summary }
}

async function cardOf(
  deps: Deps,
  site: SiteRecord,
  versionId: string,
  url: string
): Promise<SlackUnfurl> {
  const { config } = deps
  const version = await deps.store.getVersion(site, versionId)
  const publisher = version?.publishedBy ? await deps.store.getUser(version.publishedBy) : null
  // Signed, not expiring: Slack fetches the picture again whenever it shows the message.
  const secret = config.secrets.slackSigningSecret
  const imageUrl =
    site.thumbnail && secret
      ? `${config.appOrigin}${SLACK_BASE}/thumbnails/${encodeURIComponent(site.id)}/${thumbnailSignature(secret, site.id)}`
      : undefined
  return siteCard({
    name: site.name,
    url,
    siteUrl: siteUrl(siteLabel(site.name), config.sitesDomain, `${config.siteScheme}:`),
    appOrigin: config.appOrigin,
    instanceName: config.instanceName,
    ...(version?.title ? { title: version.title } : {}),
    access: accessOfSite(site),
    publishedAt: version?.createdAt ?? site.updatedAt,
    ...(version?.publishedBy ? { publishedBy: publisher?.name || version.publishedBy } : {}),
    ...(imageUrl ? { imageUrl } : {}),
    review: config.comments,
  })
}
