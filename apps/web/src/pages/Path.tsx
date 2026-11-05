/**
 * One Path of a site (`paths` capability), under the site's page: its folder, title and link, the
 * review link opened on it, its versions with restore, its owners and publishers, and archive or
 * delete. What the page offers follows the reader's standing (`lib/paths.ts`): restore for those
 * who publish to it, the role editors and the danger zone for its owners and the site's. An unknown
 * Path, or one the reader may not see, is the 404 page, as the API answers both the same way.
 * Someone who publishes to the Path alone holds no role on the site, so its page is closed to
 * them: the site's detail is then missing, and the page goes on from the Path's.
 */
import { useParams } from 'react-router-dom'
import { NotFound } from '../components/NotFound'
import { PageHeader } from '../components/PageHeader'
import { ReviewButton, ViewSiteButton } from '../components/SiteButtons'
import { PathDangerZone } from '../components/site/PathDangerZone'
import { PathTeam } from '../components/site/PathTeam'
import { PathVersions } from '../components/site/PathVersions'
import { useInstance } from '../hooks/instance'
import { useMe, usePathDetail, useSiteDetail } from '../hooks/queries'
import { ApiError, errorMessage } from '../lib/api'
import { fullDate, timeAgo } from '../lib/format'
import { canManagePath, canRestorePath, shownFolder } from '../lib/paths'
import { siteHref } from '../lib/sites'

export default function PathPage() {
  const { name = '', folder = '' } = useParams()
  const instance = useInstance()
  const enabled = name !== '' && folder !== '' && instance?.capabilities.paths !== false
  const site = useSiteDetail(name, enabled)
  const path = usePathDetail(name, folder, enabled)
  const { data: me } = useMe()

  if (instance && instance.capabilities.paths !== true) return <NotFound />
  // The site's detail answers 404 to anyone who holds no role on the site; the Path decides.
  const siteMissing = site.error instanceof ApiError && site.error.status === 404
  if (path.isPending || (site.isPending && !siteMissing)) {
    return (
      <div className="grid place-items-center py-12">
        <span
          className="loading loading-spinner loading-md text-muted"
          role="status"
          aria-label="Loading"
        />
      </div>
    )
  }
  const failed = path.isError ? path : site.isError && !siteMissing ? site : null
  if (failed) {
    if (failed.error instanceof ApiError && failed.error.status === 404) return <NotFound />
    return (
      <div className="mx-auto max-w-5xl">
        <div className="alert alert-error text-sm" role="alert">
          {errorMessage(failed.error)}
          <button type="button" className="btn btn-sm" onClick={() => failed.refetch()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const s = site.data
  const p = path.data
  if (!p) return <NotFound />
  const shown = shownFolder(p.folder)
  const siteArchived = s?.archived === true
  const live = !siteArchived && !p.archived && p.currentVersionId !== null
  const reviewable = instance?.capabilities.comments === true && live
  const manage = canManagePath(p, s?.role, me?.email)
  const siteOwner = s?.role === 'owner' || s?.role === 'admin'

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        breadcrumbs={[
          s?.role === 'admin'
            ? { to: '/?view=all', label: 'All sites' }
            : { to: '/', label: 'Sites' },
          ...(s ? [{ to: siteHref(s.name), label: s.name }] : []),
        ]}
        title={shown}
        description={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {p.title && <span className="[overflow-wrap:anywhere]">{p.title}</span>}
            {p.archived && <span className="badge badge-sm badge-ghost">Archived</span>}
            {p.currentVersionId === null && (
              <span className="badge badge-sm badge-ghost">Not published</span>
            )}
            <span className="text-muted" title={fullDate(p.updatedAt)}>
              Updated {timeAgo(p.updatedAt)}
              {p.createdBy && ` · made by ${p.createdBy}`}
            </span>
          </span>
        }
        actions={
          live && (
            <>
              {reviewable && <ReviewButton name={name} path={shown} />}
              <ViewSiteButton name={`${name}${shown}`} url={p.url} />
            </>
          )
        }
      />
      <PathVersions
        name={name}
        served={!siteArchived}
        path={p}
        canRestore={canRestorePath(p, s?.role) && !siteArchived}
      />
      <PathTeam name={name} path={p} editable={manage} siteOwner={siteOwner} />
      {manage && <PathDangerZone name={name} path={p} />}
    </div>
  )
}
