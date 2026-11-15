/**
 * What the API offers about site servers (the `servers` capability; without it these answer 404,
 * like a route that isn't there):
 *
 *   GET    /api/sites/:name/secrets            the site secrets by name, who set each and when, and
 *                                              the names the live version declares (`site.secrets`)
 *   PUT    /api/sites/:name/secrets/:secret    { value } set one, then redeploy (below)
 *   DELETE /api/sites/:name/secrets/:secret    remove one, then redeploy the live server
 *   GET    /api/sites/:name/logs?since&limit    the server's log (`site.logs`)
 *   PUT    /api/admin/sites/:name/server       { stopped?, limits? } the kill switch and the site's
 *                                              limits (`site.server`: admins, browser session)
 *   POST   /api/admin/sites/:name/viewers/resolve  { id } whose viewer id it is
 *                                              (`admin.viewers.resolve`, audited)
 *
 * A site is resolved through policy (`requireSite`), so a refusal is a 404 like a missing site.
 *
 * Setting or removing a secret redeploys, as `wrangler secret put` does:
 *   - the live version's server is reconfigured with the site's secrets as they now are and
 *     probed again (`live`); a failed probe is reported, not undone: the secret stays as set and
 *     that version keeps serving with it;
 *   - a set that leaves none of the waiting publish's declared secrets unset
 *     (`SiteServerState.awaiting`, publication.ts) publishes it, as finalizing it again would, by
 *     the one who set the secret (`deployed`: live at its URL, or the publish's refusal); with
 *     some still unset, `missing` names them.
 */
import type {
  DeleteSiteSecretResponse,
  PutSiteSecretResponse,
  SecretDeployedOutcome,
  SecretLiveOutcome,
  ServerLogLine,
  SiteSecretsResponse,
} from '@fling/shared'
import { z } from 'zod'
import { ensure } from '../admin.ts'
import type { ServerLimits } from '../config.ts'
import { ApiError, notFound } from '../lib/errors.ts'
import type { Principal } from '../policy.ts'
import { publish } from '../publication.ts'
import { auditAdmin, requireSite, requireSiteAs, save } from '../sites.ts'
import type { SiteRecord, User } from '../store/types.ts'
import type { Deps } from '../types.ts'
import { probeServer, reconfigureLive, serverSite, serversOn } from './index.ts'
import { readLogs, resolveViewer, sinceOf } from './logs.ts'
import { listSecrets, removeSecret, secretValues, setSecret } from './secrets.ts'

/** 404 unless the instance runs site servers: the routes are not there without them. */
export function requireServers(deps: Deps) {
  if (!serversOn(deps)) throw notFound()
}

/** The secrets the site's live version declares (none without a server). */
async function declared(deps: Deps, site: SiteRecord): Promise<string[]> {
  if (!site.currentVersionId) return []
  const version = await deps.store.getVersion(site, site.currentVersionId)
  return version?.server?.secrets ?? []
}

/** The live server runs with the site's secrets as they are now, and is probed again. */
async function redeployLive(deps: Deps, site: SiteRecord): Promise<SecretLiveOutcome | undefined> {
  const live = await reconfigureLive(deps, site)
  if (!live || !serversOn(deps)) return undefined
  if (live.moved) await save(deps, site)
  const probe = await probeServer(deps, site, live.version.id, live.version.server)
  if (probe.ok) return { versionId: live.version.id, ok: true }
  return {
    versionId: live.version.id,
    ok: false,
    error: 'server_failed_to_start',
    message: `Version ${live.version.id} is still the one serving "${site.name}", with the secrets as they are now, but ${probe.message}`,
    logs: probe.logs,
  }
}

/** The publish that waited for secrets: published once every one it declares is set. */
async function deployAwaiting(
  deps: Deps,
  user: User,
  site: SiteRecord
): Promise<{ deployed?: SecretDeployedOutcome; missing?: string[] }> {
  const awaiting = site.server?.awaiting
  if (!awaiting) return {}
  const version = await deps.store.getVersion(site, awaiting.versionId)
  if (version?.status !== 'pending' || !version.server) return {}
  const { missing } = await secretValues(deps, site.id, version.server.secrets)
  if (missing.length > 0) return { missing }
  try {
    const published = await publish(deps, user, site.name, version.id)
    return { deployed: { versionId: version.id, url: published.site.url } }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    if (err.code !== 'secrets_missing') await stopWaiting(deps, site.name, version.id)
    const logs = err.extra?.logs
    return {
      deployed: {
        versionId: version.id,
        error: err.code,
        message: err.message,
        ...(Array.isArray(logs) ? { logs: logs as string[] } : {}),
      },
    }
  }
}

/** A waiting publish refused for another reason waits no more: it is published again by hand. */
async function stopWaiting(deps: Deps, name: string, versionId: string) {
  const site = await deps.store.findSite(name)
  if (site?.server?.awaiting?.versionId !== versionId) return
  const { awaiting: _, ...rest } = site.server
  site.server = rest
  await save(deps, site)
}

export async function siteSecrets(
  deps: Deps,
  user: User,
  name: string
): Promise<SiteSecretsResponse> {
  requireServers(deps)
  const site = await requireSite(deps, user, name, 'site.secrets')
  return listSecrets(deps, site, await declared(deps, site))
}

export async function putSiteSecret(
  deps: Deps,
  user: User,
  name: string,
  secret: string,
  value: string
): Promise<PutSiteSecretResponse> {
  requireServers(deps)
  const site = await requireSite(deps, user, name, 'site.secrets')
  const set = await setSecret(deps, site, secret, value, user.email)
  const live = await redeployLive(deps, site)
  const waiting = await deployAwaiting(deps, user, site)
  return { ...set, ...(live ? { live } : {}), ...waiting }
}

export async function deleteSiteSecret(
  deps: Deps,
  user: User,
  name: string,
  secret: string
): Promise<DeleteSiteSecretResponse> {
  requireServers(deps)
  const site = await requireSite(deps, user, name, 'site.secrets')
  await removeSecret(deps, site, secret)
  const live = await redeployLive(deps, site)
  return { name: secret, ...(live ? { live } : {}) }
}

export async function siteLogs(
  deps: Deps,
  user: User,
  name: string,
  query: { since?: string; limit?: string }
): Promise<ServerLogLine[]> {
  requireServers(deps)
  const site = await requireSite(deps, user, name, 'site.logs')
  const since = sinceOf(deps.clock.now(), query.since)
  const limit = query.limit ? Number(query.limit) || undefined : undefined
  return readLogs(deps, site, since, limit)
}

const positive = z.number().int().positive()

/** PUT /api/admin/sites/:name/server: what an admin may set on one site's server. */
export const AdminServerRequestSchema = z.object({
  stopped: z.boolean().optional(),
  /** each over the instance's (`SERVER_*`); null puts one back to the instance's */
  limits: z
    .object({
      timeoutSeconds: positive.max(900).nullable().optional(),
      cpuMs: positive.max(300_000).nullable().optional(),
      rps: positive.max(100_000).nullable().optional(),
      environments: positive.max(10_000).nullable().optional(),
      bodyBytes: positive
        .max(100 * 1024 * 1024)
        .nullable()
        .optional(),
    })
    .optional(),
})
export type AdminServerRequest = z.infer<typeof AdminServerRequestSchema>

/** The site's server as an admin sees it: stopped or not, and the limits it runs with. */
export interface AdminServerState {
  name: string
  hasServer: boolean
  stopped: boolean
  limits: ServerLimits
  /** the limits raised for this site (the rest are the instance's) */
  raised: Partial<ServerLimits>
}

/**
 * An admin's kill switch and limits for one site's server (`site.server`, audited as a change):
 * stopped, the route says `x` and `/api/*` answers 503; the platform is told either way.
 */
export async function adminSetServer(
  deps: Deps,
  user: User,
  name: string,
  req: AdminServerRequest
): Promise<AdminServerState> {
  requireServers(deps)
  const { site, actor } = await requireSiteAs(deps, user, name, 'site.server')
  await auditAdmin(deps, actor, site, 'site.server')
  const state = { ...site.server }
  if (req.stopped !== undefined) {
    if (req.stopped) state.stopped = true
    else delete state.stopped
  }
  if (req.limits) {
    const limits: Partial<ServerLimits> = { ...state.limits }
    for (const [k, v] of Object.entries(req.limits) as [keyof ServerLimits, number | null][]) {
      if (v === null) delete limits[k]
      else if (v !== undefined) limits[k] = v
    }
    if (Object.keys(limits).length) state.limits = limits
    else delete state.limits
  }
  site.server = state
  if (req.limits) await reconfigureLive(deps, site)
  await save(deps, site)
  if (req.stopped !== undefined && deps.servers) {
    await deps.servers.setEnabled(serverSite(site), !site.archived && !site.server.stopped)
  }
  return {
    name: site.name,
    hasServer: site.server.live === true,
    stopped: site.server.stopped === true,
    limits: { ...deps.config.servers.limits, ...site.server.limits },
    raised: { ...site.server.limits },
  }
}

/** Whose viewer id `id` is on the site (an admin, with any credential; audited). */
export async function adminResolveViewer(
  deps: Deps,
  user: User,
  p: Principal,
  name: string,
  id: string
): Promise<{ id: string; email: string | null }> {
  ensure(p, 'admin.viewers.resolve')
  requireServers(deps)
  const site = await requireSite(deps, user, name, 'site.read')
  return { id, email: await resolveViewer(deps, user.email, site, id) }
}
