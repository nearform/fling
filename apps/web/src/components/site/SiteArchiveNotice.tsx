/**
 * The site page's archive policy notices (`archivePolicy` capability): "Will be archived on …" or
 * "Will be deleted on …" from the site's `archiveDue`, which the API sends to its owners,
 * publishers and admins while the policy is live; and, on a site the policy archived, that it did
 * and what brings it back. Those who may keep it (owners and admins) are pointed at Keep.
 */
import type { SiteDetail } from '@fling/shared'
import { ArchiveBoxIcon, ClockIcon } from '@heroicons/react/24/outline'
import { archiveDueText, policyArchivedText } from '../../lib/archive-policy'

export function SiteArchiveNotice({
  site,
  canKeep,
  onKeep,
}: {
  site: SiteDetail
  /** an owner or an admin: Keep, in Settings, exempts it */
  canKeep: boolean
  onKeep: () => void
}) {
  const archived = policyArchivedText(site)
  const keep = canKeep && (
    <>
      {' '}
      <button type="button" className="link" onClick={onKeep}>
        Keep it
      </button>{' '}
      to exempt it from the archive policy.
    </>
  )
  return (
    <>
      {site.archiveDue && (
        <div className="alert alert-warning text-sm" role="note">
          <ClockIcon className="size-5" aria-hidden="true" />
          <span>
            {archiveDueText(site.archiveDue)}
            {keep}
          </span>
        </div>
      )}
      {archived && !site.archiveDue && (
        <div className="alert alert-info text-sm" role="note">
          <ArchiveBoxIcon className="size-5" aria-hidden="true" />
          <span>{archived}</span>
        </div>
      )}
      {archived && site.archiveDue && <p className="text-sm text-secondary">{archived}</p>}
    </>
  )
}
