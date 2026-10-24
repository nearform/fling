/**
 * While an admin impersonates someone: a bar across the top of every signed-in page saying whom
 * they are viewing as, with Stop (back to their own session and the users list). Never hidden,
 * never dismissable.
 */
import { EyeIcon } from '@heroicons/react/24/outline'
import { useImpersonation, useMe } from '../hooks/queries'
import { impersonationNotice } from '../lib/admin'
import { fullDate } from '../lib/format'

export function ImpersonationBanner() {
  const { data: me } = useMe()
  const { stop } = useImpersonation()
  const notice = impersonationNotice(me)
  if (!me || !notice) return null
  return (
    <div className="impersonation-banner" role="status">
      <EyeIcon className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0">
        <strong className="impersonation-who">{notice}</strong>
        <span className="impersonation-detail">
          {' '}
          — you are {me.impersonator}
          {me.impersonationEndsAt && `, until ${fullDate(me.impersonationEndsAt)}`}
        </span>
      </p>
      <button
        type="button"
        className="btn btn-sm impersonation-stop"
        onClick={() => stop.mutate()}
        disabled={stop.isPending}
      >
        {stop.isPending ? <span className="loading loading-spinner loading-xs" /> : 'Stop'}
      </button>
    </div>
  )
}
