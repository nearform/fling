/**
 * The two links people share for a site, with one look everywhere they appear (the site rows,
 * Shared with me, the site page), each with a copy button beside it:
 * - Review Site: the site with its comments, the link to share for feedback. The caller decides
 *   whether the site can be reviewed (comments on, not archived).
 * - View Site: the site itself, in a new tab.
 */
import { ArrowTopRightOnSquareIcon, ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline'
import { Link } from 'react-router-dom'
import { reviewHref } from '../lib/review'
import { CopyButton } from './CopyButton'

const buttonClass = 'btn btn-xs h-7 min-h-7 gap-1 px-2 text-sm font-normal'
const copyClass = 'btn btn-ghost btn-xs btn-square h-7 min-h-7 w-7 shrink-0'
const wrapClass = 'relative z-10 inline-flex shrink-0 items-center'

export function ReviewButton({ name }: { name: string }) {
  return (
    <span className={wrapClass}>
      <Link
        to={reviewHref(name)}
        className={`${buttonClass} tone-primary hover:brightness-95`}
        title="Open the site with its comments: the link to share for feedback"
      >
        <ChatBubbleLeftRightIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Review Site
      </Link>
      <CopyButton
        text={`${window.location.origin}${reviewHref(name)}`}
        label={`Copy the review link of ${name} (anyone who can open the site can comment)`}
        className={copyClass}
      />
    </span>
  )
}

export function ViewSiteButton({ name, url }: { name: string; url: string }) {
  return (
    <span className={wrapClass}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={`${buttonClass} btn-ghost border-[var(--border-control)]`}
        title={url}
      >
        <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        View Site
        <span className="sr-only">(opens in a new tab)</span>
      </a>
      <CopyButton text={url} label={`Copy the URL of ${name}`} className={copyClass} />
    </span>
  )
}
