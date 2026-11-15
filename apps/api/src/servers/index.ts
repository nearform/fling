/**
 * Site servers in the core: everything about them that isn't a platform's (servers/types.ts has
 * the ports). Publication (publication.ts) and rollback (sites.ts) call in here; nothing else
 * decides whether a server may go live.
 *
 * Admission (`admitServer`, from the manifest, before anything is stored), in this order:
 *   - a Path publish with any file under `_fling/` → 400 `server_on_path` (servers run at the
 *     site's root only);
 *   - the instance runs no servers (`SERVERS=off`, or a platform without a SiteServers adapter),
 *     or `SERVERS` doesn't name the publisher (`canPublishServer`) → 403 `servers_not_allowed`;
 *   - a bundle over SERVER_BUNDLE_MAX_BYTES → 413 `too_large`;
 *   - the site has a Path at `api`, which the server's `/api/*` would hide → 409 `path_conflict`;
 *   - the site has no server yet and SERVERS_MAX_SITES sites have one → 409 `too_many_servers`;
 *   - the site is (or the deploy makes it) public and the deploy doesn't say
 *     `confirmPublicServer: true`, unless its live version already has a server on the public site
 *     → 409 `public_server`, whose message is what to ask the publisher.
 * With the bytes (`checkBundle`, at finalize or in an inline publish): any import but `node:*` and
 * Fling's helpers → 400 `server_not_bundled`. The bundle is secret-scanned like every file.
 *
 * Going live (`startServer`, for a publish, a repoint and a rollback alike): the publisher may
 * still publish servers; every secret the version declares is set (409 `secrets_missing`, naming
 * them); then the platform readies it (`SiteServers.activate`) and the start probe asks it once,
 * before the route changes: the health path `fling.json` names, which must answer 2xx, or else
 * SERVER_PREFIX, where any HTTP answer will do. No answer within SERVER_PROBE_TIMEOUT_MS, or a
 * crash, is 422 `server_failed_to_start` with the first lines of the server's log; the version
 * stays as it was (pending, for a publish) and the live one keeps serving. A probe that passed
 * hands the site's requests to the version where the platform switches them itself
 * (`SiteServers.goLive`: AWS's revision weights). Then the site records
 * where the server is reached (`SiteRecord.server.target`, the route value's `t`), the
 * `SERVERS/SITE#` index item counts it, and `site.server_published` is audited.
 */
import {
  type ManifestFile,
  SERVER_BUNDLE,
  SERVER_BUNDLE_MAX_BYTES,
  SERVER_HELPER_MODULE,
  SERVER_PROBE_DEFAULT_PATH,
  SERVER_PROBE_TIMEOUT_MS,
  SERVER_START_LOG_LINES,
  type ServerConfig,
  siteObjectKey,
  siteVersionPrefix,
  unbundledImports,
  type Visibility,
} from '@fling/shared'
import { audit } from '../audit.ts'
import type { ServerLimits } from '../config.ts'
import { ApiError, conflict, forbidden } from '../lib/errors.ts'
import { canPublishServer, type Principal } from '../policy.ts'
import type { ServerMark, SiteRecord, User, VersionRecord } from '../store/types.ts'
import type { Deps } from '../types.ts'
import { secretValues } from './secrets.ts'
import type { ServerOptions, ServerSite, ServerVersion, SiteServers } from './types.ts'

/** The module a server imports Fling's helpers from: the CLI package's `/server`. */
export { SERVER_HELPER_MODULE }

/** The folder name a site server takes over: `/api/*` of the site. */
export const SERVER_PATH_FOLDER = 'api'

/** The instance runs site servers: `SERVERS` is on and the platform gave an adapter. */
export const serversOn = (deps: Deps): deps is Deps & { servers: SiteServers } =>
  deps.config.servers.publish.kind !== 'off' && deps.servers !== undefined

/** The files include a server bundle. */
export const hasServerBundle = (files: readonly Pick<ManifestFile, 'path'>[]) =>
  files.some(f => f.path === SERVER_BUNDLE)

export const serverSite = (site: Pick<SiteRecord, 'id' | 'name'>): ServerSite => ({
  id: site.id,
  name: site.name,
})

export const serverVersion = (siteId: string, versionId: string): ServerVersion => ({
  id: versionId,
  bundle: siteObjectKey(siteId, versionId, SERVER_BUNDLE),
  files: siteVersionPrefix(siteId, versionId),
})

/** The request's user as a principal for `server.publish`, where only the user is at hand. */
export function principalOfUser(user: User): Principal {
  return {
    email: user.email,
    admin: user.admin !== undefined,
    via: user.admin === 'token' ? 'api_key' : 'session',
    guest: user.guest === true,
  }
}

/** Whether `SERVERS` lets this principal publish a server (with their groups' slugs read). */
export async function mayPublishServer(deps: Deps, p: Principal): Promise<boolean> {
  if (!serversOn(deps)) return false
  const setting = deps.config.servers.publish
  let groups: string[] = []
  if (setting.kind === 'groups') {
    const ids = await deps.store.listMemberships(p.email)
    groups = (await deps.store.getGroups(ids)).map(g => g.slug)
  }
  return canPublishServer(p, setting, groups)
}

const notAllowed = (deps: Deps) =>
  forbidden(
    serversOn(deps)
      ? 'Site servers on this Fling are published only by those its admins name (SERVERS): publish without _fling/server.mjs, or ask an admin'
      : "This Fling doesn't run site servers: publish without _fling/server.mjs",
    'servers_not_allowed'
  )

/** The live version of a site has a server, on the site as it is now. */
async function liveServer(deps: Deps, site: SiteRecord | null): Promise<boolean> {
  if (!site?.currentVersionId || site.archived) return false
  const current = await deps.store.getVersion(site, site.currentVersionId)
  return current?.server !== undefined
}

/** The message a server on a public site needs confirmed (409 `public_server`). */
export const publicServerMessage = (name: string) =>
  `"${name}" is public and this version has a server: anyone can call its /api/* without the page, and use its secrets through it. Ask the user to confirm, then publish again with confirmPublicServer (the CLI's --yes).`

/**
 * Admission for a deploy whose files may include a server (see the header). `site` is the site
 * as it is (null: a new one); `visibility`, whether it is public once the deploy goes live.
 * Returns the version's server mark, or undefined when it has no server.
 */
export async function admitServer(
  deps: Deps,
  p: Principal,
  opts: {
    name: string
    site: SiteRecord | null
    files: readonly ManifestFile[]
    path?: string
    server?: ServerConfig
    visibility: Visibility
    confirmPublicServer?: boolean
  }
): Promise<ServerMark | undefined> {
  if (opts.path !== undefined) {
    const prefix = `${opts.path}/_fling/`
    if (opts.files.some(f => f.path.startsWith(prefix))) {
      throw new ApiError(
        400,
        'server_on_path',
        `A Path can't have a server, nor anything under _fling/: servers run at the site's root. Publish the server without a path`
      )
    }
    return undefined
  }
  const bundle = opts.files.find(f => f.path === SERVER_BUNDLE)
  if (!bundle) return undefined
  if (!(await mayPublishServer(deps, p))) throw notAllowed(deps)
  if (bundle.size > SERVER_BUNDLE_MAX_BYTES) {
    throw new ApiError(
      413,
      'too_large',
      `${SERVER_BUNDLE} is ${(bundle.size / 1024 / 1024).toFixed(1)} MB; a server's bundle is at most ${SERVER_BUNDLE_MAX_BYTES / 1024 / 1024} MB`
    )
  }
  const { site } = opts
  if (site && (await deps.store.getPath(site.id, SERVER_PATH_FOLDER))) {
    throw conflict(
      `"${site.name}" has a Path at /${SERVER_PATH_FOLDER}/, where its server would answer: delete the Path first, or publish without a server`,
      'path_conflict'
    )
  }
  await checkServerRoom(deps, site)
  if (opts.visibility === 'public' && !opts.confirmPublicServer) {
    const already = site?.visibility === 'public' && (await liveServer(deps, site))
    if (!already) throw conflict(publicServerMessage(opts.name), 'public_server')
  }
  return {
    secrets: [...new Set(opts.server?.secrets ?? [])],
    ...(opts.server?.health ? { health: opts.server.health } : {}),
  }
}

/** 409 `too_many_servers` when the site has no server yet and SERVERS_MAX_SITES sites do. */
async function checkServerRoom(deps: Deps, site: Pick<SiteRecord, 'id'> | null) {
  const { maxSites } = deps.config.servers
  const { count, listed } = await deps.store.serverSites(site?.id ?? '')
  if (!listed && count >= maxSites) {
    throw conflict(
      `This Fling runs at most ${maxSites} site servers, and has as many: publish without _fling/server.mjs, or ask an admin`,
      'too_many_servers'
    )
  }
}

/** 400 `server_not_bundled` when the bundle imports anything but `node:*` and Fling's helpers. */
export function checkBundle(bytes: Uint8Array) {
  const found = unbundledImports(new TextDecoder().decode(bytes), SERVER_HELPER_MODULE)
  if (found.length === 0) return
  throw new ApiError(
    400,
    'server_not_bundled',
    `${SERVER_BUNDLE} imports ${found.slice(0, 10).join(', ')}: a server is one file with its dependencies inside, importing only node:* and ${SERVER_HELPER_MODULE}. Bundle it (fling deploy does), or start from fling_server_template`,
    { imports: found }
  )
}

/** The limits a site's server runs with: the instance's, with any an admin raised for the site. */
export function limitsOf(deps: Deps, site: Pick<SiteRecord, 'server'>): ServerLimits {
  return { ...deps.config.servers.limits, ...site.server?.limits }
}

/** How a version's server runs: its declared secrets' values, the egress, the limits. */
export async function optionsFor(
  deps: Deps,
  site: SiteRecord,
  mark: ServerMark
): Promise<{ options: ServerOptions; missing: string[] }> {
  const { values, missing } = await secretValues(deps, site.id, mark.secrets)
  return {
    options: { secrets: values, egress: deps.config.servers.egress, limits: limitsOf(deps, site) },
    missing,
  }
}

/**
 * 409 `secrets_missing`. A pending version (a publish) waits for them: setting the last one takes
 * it live (servers/api.ts). A complete one (a rollback) is rolled back to again.
 */
const secretsMissing = (
  site: SiteRecord,
  version: Pick<VersionRecord, 'id' | 'status'>,
  missing: string[]
) => {
  const names = missing.join(', ')
  const set = `fling secrets set ${site.name} NAME`
  return conflict(
    version.status === 'pending'
      ? `Version ${version.id} of "${site.name}" needs the site secrets ${names}, which aren't set. It goes live as soon as they are: set ${missing.length === 1 ? 'it' : 'them'} (${set}); nothing needs publishing again`
      : `Version ${version.id} of "${site.name}" needs the site secrets ${names}, which aren't set: set them (${set}) and roll back again`,
    'secrets_missing',
    { secrets: missing, versionId: version.id }
  )
}

/**
 * Make a version's server ready to go live (see the header): returns where it is reached, for
 * the route value. Throws 403 `servers_not_allowed`, 409 `secrets_missing` (with `secrets` and
 * `versionId`) or `too_many_servers`, 422 `server_failed_to_start`.
 */
export async function startServer(
  deps: Deps,
  p: Principal,
  site: SiteRecord,
  version: Pick<VersionRecord, 'id' | 'server' | 'status'>
): Promise<string | null> {
  const mark = version.server
  if (!mark) return null
  if (!serversOn(deps) || !(await mayPublishServer(deps, p))) throw notAllowed(deps)
  await checkServerRoom(deps, site)
  const { options, missing } = await optionsFor(deps, site, mark)
  if (missing.length > 0) throw secretsMissing(site, version, missing)
  const ref = serverSite(site)
  const ver = serverVersion(site.id, version.id)
  const { target } = await deps.servers.activate(ref, ver, options)
  const probe = await probeServer(deps, site, version.id, mark)
  if (!probe.ok) {
    throw new ApiError(422, 'server_failed_to_start', `Not published: ${probe.message}`, {
      logs: probe.logs,
      ...(probe.status === undefined ? {} : { status: probe.status }),
    })
  }
  await deps.servers.goLive?.(ref, ver)
  return target
}

/** What a start probe found, by the core's rules (see the header). */
export type ProbeOutcome =
  | { ok: true; status: number }
  | { ok: false; message: string; logs: string[]; status?: number }

/** The start probe of an activated version's server, judged. */
export async function probeServer(
  deps: Deps & { servers: SiteServers },
  site: Pick<SiteRecord, 'id' | 'name'>,
  versionId: string,
  mark: ServerMark
): Promise<ProbeOutcome> {
  const path = mark.health ?? SERVER_PROBE_DEFAULT_PATH
  const result = await deps.servers.probe(serverSite(site), serverVersion(site.id, versionId), {
    method: 'GET',
    path,
    timeoutMs: SERVER_PROBE_TIMEOUT_MS,
  })
  const logs = result.logs.slice(0, SERVER_START_LOG_LINES)
  let problem: string | null = null
  if (!result.ok) problem = result.error
  else if (mark.health && (result.status < 200 || result.status > 299)) {
    problem = `GET ${path} answered ${result.status}, and the health path must answer 2xx`
  }
  if (!problem && result.ok) return { ok: true, status: result.status }
  return {
    ok: false,
    message: `the server of version ${versionId} didn't start (${problem}).${logs.length ? ` Its log:\n${logs.join('\n')}` : ' It printed nothing.'}`,
    logs,
    ...(result.ok ? { status: result.status } : {}),
  }
}

/**
 * The site's server state as `version` goes live on it (before the site is saved): where its
 * server is reached, or no server.
 */
export function applyServer(
  site: SiteRecord,
  version: Pick<VersionRecord, 'server'>,
  target: string | null
) {
  // Any version going live ends a wait for secrets (servers/api.ts).
  const { live: _live, target: _target, awaiting: _awaiting, ...kept } = site.server ?? {}
  if (version.server) site.server = { ...kept, live: true, ...(target ? { target } : {}) }
  else if (site.server) site.server = { ...kept, ...(_target ? { target: _target } : {}) }
}

/**
 * After the site is saved with `version` live: count it among the sites with a server (or not),
 * and audit a server going live.
 */
export async function noteLive(
  deps: Deps,
  actor: string,
  site: SiteRecord,
  version: Pick<VersionRecord, 'id' | 'server'>
) {
  await deps.store.markServerSite(site.id, site.name, version.server !== undefined)
  if (!version.server) return
  await audit(deps, {
    action: 'site.server_published',
    actor,
    target: site.name,
    change: version.id,
  })
}

/**
 * The live version's server runs with new options (a secret set or removed, an admin's limits):
 * tell the platform, and keep the target it answers with. Nothing for a site without one.
 */
export async function reconfigureLive(
  deps: Deps,
  site: SiteRecord
): Promise<{ version: VersionRecord & { server: ServerMark }; moved: boolean } | null> {
  if (!serversOn(deps) || !site.currentVersionId || !site.server?.live) return null
  const version = await deps.store.getVersion(site, site.currentVersionId)
  if (!version?.server) return null
  const { options } = await optionsFor(deps, site, version.server)
  const { target } = await deps.servers.reconfigure(
    serverSite(site),
    serverVersion(site.id, version.id),
    options
  )
  const live = version as VersionRecord & { server: ServerMark }
  if ((target ?? undefined) === site.server.target) return { version: live, moved: false }
  const { awaiting } = site.server
  applyServer(site, version, target)
  if (awaiting) site.server = { ...site.server, awaiting }
  return { version: live, moved: true }
}
