/**
 * One site, everything about it: the overview, who can open it (Access), who owns and publishes it
 * (Owners and publishers), its files and versions, and archive or delete (Danger zone). An unknown
 * site, or one you hold no role on, is the 404 page, as the API answers both the same way; an
 * admin opens anyone's (`site.role` is `admin`), and is told whose it is and that what they change
 * is on the record. A publisher sees the overview, the owners and publishers (read-only) and the
 * versions, to roll back: not Access, the share link or the danger zone. Archived sites are
 * offline, so Access waits until they are unarchived. With the `paths` capability, the site's
 * Paths are listed when it has any, each linking to its own page.
 *
 * With the `servers` capability, a site whose current version has a site server shows its Server
 * section (the kill switch and limits for admins); its owners and publishers see its Secrets once
 * any version has a server, a publish waits for secrets or a secret is set; its owners,
 * publishers and admins see its Logs.
 */
import { ShieldCheckIcon } from '@heroicons/react/24/outline'
import { useParams } from 'react-router-dom'
import { NotFound } from '../components/NotFound'
import { PageHeader } from '../components/PageHeader'
import { ResponsesLink } from '../components/review/Forms'
import { ReviewButton } from '../components/SiteButtons'
import { SiteBadges } from '../components/site/badges'
import { SiteAccess } from '../components/site/SiteAccess'
import { SiteDangerZone } from '../components/site/SiteDangerZone'
import { SiteLogs } from '../components/site/SiteLogs'
import { SiteOverview } from '../components/site/SiteOverview'
import { SitePaths } from '../components/site/SitePaths'
import { SiteSecrets } from '../components/site/SiteSecrets'
import { SiteServer } from '../components/site/SiteServer'
import { SiteTeam } from '../components/site/SiteTeam'
import { SiteVersions } from '../components/site/SiteVersions'
import { useInstance } from '../hooks/instance'
import { useMe, useSiteDetail, useSiteSecrets } from '../hooks/queries'
import { ApiError, errorMessage } from '../lib/api'

export default function Site() {
  const { name = '' } = useParams()
  const instance = useInstance()
  const detail = useSiteDetail(name, name !== '')
  const { data: me } = useMe()
  const serversOn = instance?.capabilities.servers === true
  const role = detail.data?.role
  const secrets = useSiteSecrets(
    name,
    serversOn && (role === 'owner' || role === 'publisher') && detail.isSuccess
  )

  if (detail.isPending) {
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
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) return <NotFound />
    return (
      <div className="mx-auto max-w-5xl">
        <div className="alert alert-error text-sm" role="alert">
          {errorMessage(detail.error)}
          <button type="button" className="btn btn-sm" onClick={() => detail.refetch()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const site = detail.data
  const reviewable = instance?.capabilities.comments === true && !site.archived
  // Servers before site roles report no role: the site is someone else's when its owner isn't you.
  const othersSite = site.role
    ? site.role === 'admin'
    : me != null && site.owner !== undefined && site.owner !== me.email
  const publisher = site.role === 'publisher'
  const admin = me?.admin === true
  const everServer = site.hasServer === true || site.versions.some(v => v.server)
  const showSecrets =
    secrets.data !== undefined &&
    (everServer || site.awaitingSecrets !== undefined || secrets.data.secrets.length > 0)
  const showLogs =
    serversOn &&
    everServer &&
    (site.role === 'owner' || publisher || site.role === 'admin' || admin)

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        breadcrumbs={[
          othersSite ? { to: '/?view=all', label: 'All sites' } : { to: '/', label: 'Sites' },
        ]}
        title={site.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <SiteBadges site={site} othersSite={othersSite} />
            {site.spa && (
              <span className="badge badge-sm badge-ghost" title="Unknown paths serve /index.html">
                SPA
              </span>
            )}
          </span>
        }
        actions={
          reviewable && (
            <>
              <ReviewButton name={site.name} />
              <ResponsesLink
                name={site.name}
                className="btn btn-xs h-7 min-h-7 px-2 text-sm font-normal tabular-nums"
              />
            </>
          )
        }
      />
      {othersSite && (
        <div className="alert alert-info text-sm" role="note">
          <ShieldCheckIcon className="size-5" aria-hidden="true" />
          <span>
            This is <span className="font-medium">{site.owner}</span>’s site. You are managing it as
            an admin: what you change is recorded in the audit log.
          </span>
        </div>
      )}
      <SiteOverview site={site} />
      {serversOn && site.server && (
        <SiteServer site={site} server={site.server} logs={showLogs} admin={admin} />
      )}
      {showSecrets && secrets.data && <SiteSecrets site={site} secrets={secrets.data} />}
      {!site.archived && !publisher && (
        <SiteAccess site={site} {...(othersSite && { owner: site.owner })} />
      )}
      {instance?.capabilities.siteRoles === true && <SiteTeam site={site} />}
      {instance?.capabilities.paths === true && (
        <SitePaths name={site.name} reviewable={reviewable} />
      )}
      <SiteVersions site={site} />
      {showLogs && (
        <SiteLogs name={site.name} currentVersionId={site.currentVersionId} admin={admin} />
      )}
      {!publisher && <SiteDangerZone site={site} home={othersSite ? '/?view=all' : '/'} />}
    </div>
  )
}
