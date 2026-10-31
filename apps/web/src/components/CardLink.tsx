/**
 * A site card's title as the card's link (the "card link" pattern): one real link, on the site's
 * name, stretched over the whole card with a pseudo-element, so a click anywhere on the card
 * follows it while the card's buttons, which sit above it (`relative z-10`), keep working on their
 * own. The card must be the positioned box (`relative`, or `.site-tile`), or the link would cover
 * whatever positioned ancestor it finds. Its focus ring is drawn round the card.
 *
 * Where it goes (`siteCardTarget`): the site page for whoever may manage the site (owners,
 * publishers, admins); otherwise the review page, or the site itself when the instance has no
 * comments.
 */
import { Link } from 'react-router-dom'
import { reviewHref } from '../lib/review'
import { siteHref } from '../lib/sites'

const stretched =
  'site-tile-link after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-[var(--focus-ring,currentColor)]'

export type CardTarget =
  | { kind: 'site-page'; to: string }
  | { kind: 'review'; to: string }
  | { kind: 'site'; href: string }

/** Where a site card leads: its site page when `manages`, else its review page, else the site. */
export function siteCardTarget(
  site: { name: string; url: string },
  opts: { manages: boolean; reviewable: boolean }
): CardTarget {
  if (opts.manages) return { kind: 'site-page', to: siteHref(site.name) }
  if (opts.reviewable) return { kind: 'review', to: reviewHref(site.name) }
  return { kind: 'site', href: site.url }
}

const TITLES: Record<CardTarget['kind'], (name: string) => string> = {
  'site-page': name => `Manage ${name}: access, versions, archive and delete`,
  review: name => `Review ${name}: the site with its comments`,
  site: name => `Open ${name} (opens in a new tab)`,
}

export function CardLink({ name, target }: { name: string; target: CardTarget }) {
  const title = TITLES[target.kind](name)
  if (target.kind === 'site') {
    return (
      <a href={target.href} target="_blank" rel="noreferrer" className={stretched} title={title}>
        {name}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    )
  }
  return (
    <Link to={target.to} className={stretched} title={title}>
      {name}
    </Link>
  )
}
