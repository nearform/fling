/**
 * What the API offers about site servers (the `servers` capability; without it these answer 404,
 * like a route that isn't there):
 *
 *   GET    /api/sites/:name/secrets            the site secrets by name, who set each and when, the
 *                                              names the live version declares, and those the
 *                                              version waiting for secrets declares (`site.secrets`)
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
 *   - a restored site's live version whose server waits for its secrets (deletion.ts) starts once
 *     none it declares is unset (`startAwaiting`, as the one who made the change); until then, and
 *     after any refusal, it keeps waiting and `/api/*` answers 503;
 *   - a change that leaves none of the waiting publish's declared secrets unset
 *     (`SiteServerState.awaiting`, publication.ts) publishes it, as finalizing it again would, by
 *     the one who made the change (`deployed`: live at its URL, or the publish's refusal); with
 *     some still unset, `missing` names them. A server that fails its start keeps the version
 *     waiting: every later set or remove tries it again, until it goes live or a newer publish
 *     takes its place. Any other refusal (the publisher may no longer publish servers, the
 *     instance is full) ends the wait.
 */
import {
  type DeleteSiteSecretResponse,
  type PutSiteSecretResponse,
  type SecretDeployedOutcome,
  type SecretLiveOutcome,
  type ServerLogLine,
  type SiteSecretsResponse,
  siteLabel,
  siteUrl,
} from '@fling/shared'
import { z } from 'zod'
import { ensure } from '../admin.ts'
import type { ServerLimits } from '../config.ts'
import { ApiError, badRequest, notFound } from '../lib/errors.ts'
import type { Principal } from '../policy.ts'
import { publish } from '../publication.ts'
import {
  auditAdmin,
  awaitsSecretsLive,
  changeSite,
  requireSite,
  requireSiteAs,
  writeSite,
} from '../sites.ts'
import type { ServerMark, SiteRecord, User, VersionRecord } from '../store/types.ts'
import type { Deps } from '../types.ts'
import {
  applyServer,
  limitsOf,
  noteLive,
  principalOfUser,
  probeServer,
  reconfigureLive,
  serverSite,
  serversOn,
  startServer,
} from './index.ts'
import { readLogs, resolveViewer, sinceOf } from './logs.ts'
import { listSecrets, removeSecret, secretValues, setSecret } from './secrets.ts'

/** 404 unless the instance runs site servers: the routes are not there without them. */
export function requireServers(deps: Deps) {
  if (!serversOn(deps)) throw notFound()
}

/** The version waiting for secrets and the names it declares, when there is one still pending. */
async function waitingFor(
  deps: Deps,
  site: SiteRecord
): Promise<{ versionId: string; declared: string[] } | undefined> {
  const awaiting = site.server?.awaiting
  if (!awaiting) return undefined
  const version = await deps.store.getVersion(site, awaiting.versionId)
  if (!version?.server) return undefined
  if (version.status !== 'pending' && !awaitsSecretsLive(site)) return undefined
  return { versionId: version.id, declared: version.server.secrets }
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
  if (live.moved) {
    const target = site.server?.target
    await writeSite(deps, site, s => {
      if (!s.server || s.currentVersionId !== live.version.id) return false
      const { target: _, ...rest } = s.server
      s.server = { ...rest, ...(target ? { target } : {}) }
      return true
    })
  }
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
  if (!version?.server) return {}
  if (version.status === 'complete' && awaitsSecretsLive(site)) {
    return startAwaiting(deps, user, site, version as VersionRecord & { server: ServerMark })
  }
  if (version.status !== 'pending') return {}
  const { missing } = await secretValues(deps, site.id, version.server.secrets)
  if (missing.length > 0) return { missing }
  try {
    const published = await publish(deps, user, site.name, version.id)
    return { deployed: { versionId: version.id, url: published.site.url } }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    if (!KEEPS_WAITING.has(err.code)) await stopWaiting(deps, site.name, version.id)
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

/**
 * The live version's server, waiting to start (a restored site's, deletion.ts): once every secret
 * it declares is set, it starts the usual way (`startServer`: activate, probe, go live) as `user`,
 * and the site records where it is reached. Any refusal keeps it waiting, never running, so each
 * later secret set or removed tries again; the static site serves throughout.
 */
export async function startAwaiting(
  deps: Deps,
  user: User,
  site: SiteRecord,
  version: VersionRecord & { server: ServerMark }
): Promise<{ deployed?: SecretDeployedOutcome; missing?: string[] }> {
  const { missing } = await secretValues(deps, site.id, version.server.secrets)
  if (missing.length > 0) return { missing }
  try {
    const target = await startServer(deps, principalOfUser(user), site, version)
    await writeSite(deps, site, s => {
      if (s.currentVersionId !== version.id || s.server?.awaiting?.versionId !== version.id) {
        return false
      }
      applyServer(s, version, target)
      return true
    })
    await noteLive(deps, user.email, site, version)
    // Started on an archived site, or one an admin stopped: it stays dark with it.
    if (deps.servers && (site.archived || site.server?.stopped)) {
      await deps.servers.setEnabled(serverSite(site), false)
    }
    const url = siteUrl(siteLabel(site.name), deps.config.sitesDomain, `${deps.config.siteScheme}:`)
    return { deployed: { versionId: version.id, url } }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
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

/**
 * The refusals a waiting publish keeps waiting through: a secret still unset, and a server that
 * didn't start with the secrets as they are (the next change may be the fix).
 */
const KEEPS_WAITING = new Set(['secrets_missing', 'server_failed_to_start'])

/** A waiting publish refused for another reason waits no more: it is published again by hand. */
async function stopWaiting(deps: Deps, name: string, versionId: string) {
  const site = await deps.store.findSite(name)
  if (!site) return
  await writeSite(deps, site, s => {
    if (s.server?.awaiting?.versionId !== versionId) return false
    const { awaiting: _, ...rest } = s.server
    s.server = rest
    return true
  })
}

export async function siteSecrets(
  deps: Deps,
  user: User,
  name: string
): Promise<SiteSecretsResponse> {
  requireServers(deps)
  const site = await requireSite(deps, user, name, 'site.secrets')
  return listSecrets(deps, site, await declared(deps, site), await waitingFor(deps, site))
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
  const waiting = await deployAwaiting(deps, user, site)
  return { name: secret, ...(live ? { live } : {}), ...waiting }
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
 * stopped, the route says `x` and `/api/*` answers 503; the platform is told either way. A time
 * per request past what the platform serves (`SiteServers.maxTimeoutSeconds`) is 400
 * `limit_too_high`.
 */
export async function adminSetServer(
  deps: Deps,
  user: User,
  name: string,
  req: AdminServerRequest
): Promise<AdminServerState> {
  requireServers(deps)
  const { site, actor } = await requireSiteAs(deps, user, name, 'site.server')
  const maxTimeout = deps.servers?.maxTimeoutSeconds
  const timeout = req.limits?.timeoutSeconds
  if (maxTimeout !== undefined && typeof timeout === 'number' && timeout > maxTimeout) {
    throw badRequest(
      `This Fling's platform serves a request for at most ${maxTimeout} s: set the time per request to ${maxTimeout} or less`,
      'limit_too_high'
    )
  }
  await auditAdmin(deps, actor, site, 'site.server')
  // The admin's change is made to the site as it is when written: a publish meanwhile keeps it.
  await changeSite(deps, actor, site, ['site.server'], async s => {
    const state = { ...s.server }
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
    s.server = state
    if (req.limits) await reconfigureLive(deps, s)
    return true
  })
  const server = site.server ?? {}
  if (req.stopped !== undefined && deps.servers) {
    await deps.servers.setEnabled(serverSite(site), !site.archived && !server.stopped)
  }
  return {
    name: site.name,
    hasServer: server.live === true,
    stopped: server.stopped === true,
    limits: limitsOf(deps, site),
    raised: { ...server.limits },
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
