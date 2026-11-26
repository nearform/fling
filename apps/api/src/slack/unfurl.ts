/**
 * Link previews in Slack (`link_shared` events, routes/slack.ts): for each link to a site, a card
 * (card.ts) when the person who posted it can open the site, and nothing otherwise, so Slack keeps
 * its plain preview.
 *
 * - **Who posted**: their Slack profile's email (`users.info`), as a Fling user who has signed in
 *   before and still has standing (auth/standing.ts). Admin rights are never applied: a card goes
 *   only where the poster could open the site as a member.
 * - **Which site**: a site's own host (`<name>.<sites domain>`, any page), or its review or site
 *   page on the app (`/review/<name>`, `/sites/<name>`). Share links are left to Slack: they open
 *   for anyone, so its own preview of the page is already the site's.
 * - **What it shows**: whatever the poster's `site.view` lets them see. The card goes to the whole
 *   channel, as a screenshot the poster posted would; opening the site still needs access.
 * - An archived site, or one with nothing live, gets no card.
 */

import { isValidSiteName, parseLabel, siteLabel, siteUrl } from '@fling/shared'
import { withStanding } from '../auth/standing.ts'
import { thumbnailKey } from '../blobs/types.ts'
import { can } from '../policy.ts'
import { siteActor } from '../sites.ts'
import { accessOfSite, type SiteRecord } from '../store/types.ts'
import type { Deps } from '../types.ts'
import { siteCard } from './card.ts'
import type { SlackClient, SlackUnfurl } from './client.ts'

/** At most this many links of one message get a card (Slack sends up to five). */
export const UNFURL_LINKS_MAX = 5
/** How long Slack may fetch a card's thumbnail URL for: it copies the picture on first fetch. */
const IMAGE_URL_TTL_SECONDS = 60 * 60

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

/** The cards for the links `slackUserId` posted, by link: only those they can open. */
export async function unfurlLinks(
  deps: Deps,
  slack: SlackClient,
  slackUserId: string,
  links: string[]
): Promise<Record<string, SlackUnfurl>> {
  const named = links
    .slice(0, UNFURL_LINKS_MAX)
    .map(url => ({ url, name: siteNameOf(deps, url) }))
    .filter((l): l is { url: string; name: string } => l.name !== null)
  if (!named.length) return {}

  const email = await slack.userEmail(slackUserId)
  const stored = email ? await deps.store.getUser(email) : null
  // As stored: no `admin`, which only a request's credential carries (auth/standing.ts).
  const user = stored ? await withStanding(deps, stored) : null
  if (!user) return {}

  const unfurls: Record<string, SlackUnfurl> = {}
  await Promise.all(
    named.map(async ({ url, name }) => {
      const site = await deps.store.findSite(name)
      if (!site || site.archived || !site.currentVersionId) return
      if (!can(await siteActor(deps, user, site), 'site.view', site)) return
      unfurls[url] = await cardOf(deps, site, site.currentVersionId, url)
    })
  )
  return unfurls
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
  const imageUrl = site.thumbnail
    ? await deps.blobs
        .presignGet(thumbnailKey(site.id), { expiresIn: IMAGE_URL_TTL_SECONDS })
        .catch(() => undefined)
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
