/**
 * The two links people share for a site, with one look everywhere they appear (the site rows,
 * Shared with me, the site page), each with a copy button beside it:
 * - Review: the site with its comments, the link to share for feedback. The caller decides
 *   whether the site can be reviewed (comments on, not archived).
 * - View: the site itself, in a new tab.
 * The visible labels are short; their accessible names and titles say which site. `compact` (the
 * grid's cards) draws each as two quiet icon buttons, the link and its copy, with short tooltips
 * ("Review", "Copy review link"; "Open site", "Copy site URL") and accessible names that say
 * which site; the card puts Review's pair at the start of its footer and the site's at the end.
 */
import { ArrowTopRightOnSquareIcon, ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline'
import { Link } from 'react-router-dom'
import { reviewHref } from '../lib/review'
import { CopyButton } from './CopyButton'

const buttonClass = 'btn btn-xs h-7 min-h-7 gap-1 px-2 text-sm font-normal'
const copyClass = 'btn btn-ghost btn-xs btn-square h-7 min-h-7 w-7 shrink-0'
const wrapClass = 'relative z-10 inline-flex shrink-0 items-center'
/** A compact pair: not above the card's link itself, only its buttons are. */
const compactWrapClass = 'inline-flex shrink-0 items-center'
/** A grid card's action: a borderless icon button (`.site-tile-action` in theme.css). */
const actionClass = 'site-tile-action'

export function ReviewButton({ name, compact = false }: { name: string; compact?: boolean }) {
  const copy = {
    text: `${window.location.origin}${reviewHref(name)}`,
    label: `Copy the review link of ${name} (anyone who can open the site can comment)`,
  }
  if (compact) {
    return (
      <span className={compactWrapClass}>
        <Link
          to={reviewHref(name)}
          className={actionClass}
          aria-label={`Review ${name}`}
          title="Review"
        >
          <ChatBubbleLeftRightIcon className="h-4 w-4" aria-hidden />
        </Link>
        <CopyButton {...copy} tooltip="Copy review link" className={actionClass} />
      </span>
    )
  }
  return (
    <span className={wrapClass}>
      <Link
        to={reviewHref(name)}
        className={`${buttonClass} tone-primary hover:brightness-95`}
        aria-label={`Review ${name}`}
        title={`Review ${name}: the site with its comments, the link to share for feedback`}
      >
        <ChatBubbleLeftRightIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Review
      </Link>
      <CopyButton {...copy} className={copyClass} />
    </span>
  )
}

export function ViewSiteButton({
  name,
  url,
  compact = false,
}: {
  name: string
  url: string
  compact?: boolean
}) {
  if (compact) {
    return (
      <span className={`${compactWrapClass} ms-auto`}>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className={actionClass}
          aria-label={`Open ${name} (opens in a new tab)`}
          title="Open site"
        >
          <ArrowTopRightOnSquareIcon className="h-4 w-4" aria-hidden />
        </a>
        <CopyButton
          text={url}
          label={`Copy the URL of ${name}`}
          tooltip="Copy site URL"
          className={actionClass}
        />
      </span>
    )
  }
  return (
    <span className={wrapClass}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className={`${buttonClass} btn-ghost border-[var(--border-control)]`}
        aria-label={`View ${name} (opens in a new tab)`}
        title={url}
      >
        <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        View
      </a>
      <CopyButton text={url} label={`Copy the URL of ${name}`} className={copyClass} />
    </span>
  )
}
