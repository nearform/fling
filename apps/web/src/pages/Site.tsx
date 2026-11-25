/**
 * One site, everything about it: the header and the overview, then tabs (`?tab=`,
 * `lib/site-tabs.ts`). Access, the first, is who can open it and who owns and publishes it
 * (Owners and publishers); Versions is its files and versions, and its Paths; Server is its site
 * server, secrets and logs; Settings is archive or delete (Danger zone). A tab the viewer has
 * nothing in is left out. An unknown site, or one you hold no role on, is the 404 page, as the API
 * answers both the same way; an admin opens anyone's (`site.role` is `admin`), and is told whose
 * it is and that what they change is on the record. A publisher sees the overview, the owners and
 * publishers (read-only) and the versions, to roll back: not Access, the share link or the danger
 * zone. Archived sites are offline, so Access waits until they are unarchived. With the `paths`
 * capability, the site's Paths are listed when it has any, each linking to its own page.
 *
 * With the `servers` capability, a site whose current version has a site server shows its Server
 * section (the kill switch and limits for admins); its owners and publishers see its Secrets once
 * any version has a server, a publish waits for secrets or a secret is set; its owners,
 * publishers and admins see its Logs. A publish waiting for secrets marks the Server tab.
 *
 * With the `metrics` capability, its owners, publishers and admins see its Metrics below the
 * overview (SiteMetrics): views and pushes, counts only.
 *
 * With the `archivePolicy` capability, the page says when the archive policy will archive or
 * delete the site, or that it archived it (SiteArchiveNotice), and Settings has its Keep switch.
 */
import { archivePolicyOf } from '@fling/shared'
import { ShieldCheckIcon } from '@heroicons/react/24/outline'
import { useParams, useSearchParams } from 'react-router-dom'
import { NotFound } from '../components/NotFound'
import { PageHeader } from '../components/PageHeader'
import { ResponsesLink } from '../components/review/Forms'
import { ReviewButton } from '../components/SiteButtons'
import { SiteBadges } from '../components/site/badges'
import { SiteAccess } from '../components/site/SiteAccess'
import { SiteArchiveNotice } from '../components/site/SiteArchiveNotice'
import { SiteDangerZone } from '../components/site/SiteDangerZone'
import { SiteLogs } from '../components/site/SiteLogs'
import { SiteMetrics } from '../components/site/SiteMetrics'
import { SiteOverview } from '../components/site/SiteOverview'
import { SitePaths } from '../components/site/SitePaths'
import { SiteSecrets } from '../components/site/SiteSecrets'
import { SiteServer } from '../components/site/SiteServer'
import { SiteTabPanel, SiteTabs } from '../components/site/SiteTabs'
import { SiteTeam } from '../components/site/SiteTeam'
import { SiteVersions } from '../components/site/SiteVersions'
import { useInstance } from '../hooks/instance'
import { useMe, useSiteDetail, useSiteSecrets } from '../hooks/queries'
import { ApiError, errorMessage } from '../lib/api'
import { metricsShown } from '../lib/metrics'
import { type SiteTab, siteTabOf, siteTabParam, siteTabsFor } from '../lib/site-tabs'

export default function Site() {
  const { name = '' } = useParams()
  const [params, setParams] = useSearchParams()
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
  const showServer = serversOn && site.server !== undefined
  const showAccess = !site.archived && !publisher
  const showTeam = instance?.capabilities.siteRoles === true
  const tabs = siteTabsFor({
    access: showAccess || showTeam,
    server: showServer || showSecrets || showLogs,
    settings: !publisher,
  })
  const tab = siteTabOf(params.get('tab'), tabs)
  const selectTab = (next: SiteTab) =>
    setParams(
      prev => {
        const p = new URLSearchParams(prev)
        const value = siteTabParam(next, tabs)
        if (value) p.set('tab', value)
        else p.delete('tab')
        return p
      },
      { replace: true }
    )

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
      <SiteArchiveNotice
        site={site}
        canKeep={archivePolicyOf(instance) && tabs.includes('settings')}
        onKeep={() => selectTab('settings')}
      />
      <SiteOverview site={site} />
      {metricsShown(instance, site, admin) && <SiteMetrics name={site.name} />}
      <SiteTabs
        tabs={tabs}
        selected={tab}
        onSelect={selectTab}
        {...(site.awaitingSecrets && {
          attention: { server: 'a version is waiting for secrets' },
        })}
      />
      <SiteTabPanel tab={tab}>
        {tab === 'access' && (
          <>
            {showAccess && <SiteAccess site={site} {...(othersSite && { owner: site.owner })} />}
            {showTeam && <SiteTeam site={site} />}
          </>
        )}
        {tab === 'versions' && (
          <>
            <SiteVersions site={site} />
            {instance?.capabilities.paths === true && (
              <SitePaths name={site.name} reviewable={reviewable} />
            )}
          </>
        )}
        {tab === 'server' && (
          <>
            {showServer && site.server && (
              <SiteServer site={site} server={site.server} logs={showLogs} admin={admin} />
            )}
            {showSecrets && secrets.data && <SiteSecrets site={site} secrets={secrets.data} />}
            {showLogs && (
              <SiteLogs name={site.name} currentVersionId={site.currentVersionId} admin={admin} />
            )}
          </>
        )}
        {tab === 'settings' && (
          <SiteDangerZone site={site} home={othersSite ? '/?view=all' : '/'} />
        )}
      </SiteTabPanel>
    </div>
  )
}
