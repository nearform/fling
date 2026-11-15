/**
 * Site servers on AWS: a Lambda Web Function per site (`<prefix><siteId>`, tagged with the
 * instance and the site), a revision per version and per configuration it runs with, built from
 * the version's zip (zip.ts) in the versioned server zip bucket (zips.ts).
 *
 *   - Two endpoints, both IAM-authenticated: `live`, which CloudFront reaches (the route value's
 *     `t` is its domain; the function's resource policy lets only the sites distribution invoke
 *     it), and `probe`, which only the API's role may call. activate readies the revision and
 *     leaves `live` alone; probe points `probe` at the revision and asks it, checking the answer
 *     came from that revision (`lambda-web-logstream`), since traffic is mixed for a moment after
 *     a switch; goLive, once the core judged the probe, moves `live`'s revision weights. So a
 *     version's server is asked before it takes a single request, and a rollback is one weights
 *     change to a revision that is still there.
 *   - A revision is found again by its label (naming.ts: the version and a hash of the zip's
 *     object version, the secrets, the timeout, the body limit, the role and the egress
 *     connector): activating a version again, or reconfiguring with the same options, makes no new
 *     revision. A changed secret makes one, which reconfigure puts live at once. Revisions of a
 *     version nothing routes to are deleted before a new one is made, so a site keeps few, and
 *     old secret values (which GetWebFunctionRevision shows) do not linger.
 *   - Limits: the wall time and body size are the entry's (web-entry.ts) to the second and byte,
 *     the revision's timeoutSeconds Lambda's backstop (3 to 900 s); requests per second are the
 *     live endpoint's rateLimit, in the steps Lambda takes (`rateStep`); environments its
 *     maxEnvironments (at least 2). Egress `none` needs the instance's network connector
 *     (Terraform's servers.egress): a revision is never made with egress open when `none` was
 *     asked for.
 *   - The kill switch (setEnabled false: an admin's stop, archiving) sets `live`'s rateLimit to 0
 *     (503 EndpointDisabled) and tags the function stopped, so later changes keep it at 0;
 *     setEnabled true restores the rate it ran at.
 *   - The first server on the account is refused (409 `servers_quota`) when SERVERS_MAX_SITES ×
 *     SERVER_ENVIRONMENTS × 2 vCPU exceeds the account's Arm vCPU quota for Web Functions.
 *   - retire deletes a version's revisions and zip, or the site's function, its two log groups
 *     and its zips. Lambda may write a deleted function's central log group again a minute later;
 *     the hourly sweep (`sweep`) deletes those, and any tagged function whose site is gone.
 */
import { createHash } from 'node:crypto'
import type { Blobs } from '@fling/api/blobs'
import { ApiError } from '@fling/api/errors'
import type {
  ProbeRequest,
  ProbeResult,
  ServerOptions,
  ServerSite,
  ServerVersion,
  SiteServers,
} from '@fling/api/servers/types'
import { SERVER_SITE_HEADER } from '@fling/shared/route-keys'
import { SERVER_START_LOG_LINES } from '@fling/shared/site-server'
import { ENTRY_ENV, LOG_RETENTION_DAYS, SERVER_ERROR_HEADER } from './entry-contract.ts'
import {
  functionName,
  LIVE_ENDPOINT,
  LOG_GROUP_PREFIX,
  logGroupsOf,
  PROBE_ENDPOINT,
  parseRevisionLabel,
  revisionLabel,
  siteIdOf,
  TAG_INSTANCE,
  TAG_RATE,
  TAG_SITE,
  TAG_STOPPED,
} from './naming.ts'
import type { CloudWatchServerLogs, LogEventsApi } from './server-logs.ts'
import type {
  EndpointSettings,
  RevisionSpec,
  RevisionState,
  RevisionWeight,
  WebFunctionsApi,
} from './web-functions.ts'
import { revisionZip, type ServerRuntime } from './zip.ts'
import { type ServerZips, zipKey } from './zips.ts'

/** What Terraform gives the adapter (servers/config.ts reads it from the environment). */
export interface AwsServersSettings {
  /** every site's function name starts with it (SERVER_FUNCTION_PREFIX) */
  functionPrefix: string
  /** the `fling:instance` tag the IAM fence requires (SERVER_INSTANCE) */
  instance: string
  /** the servers' execution role: logs only (SERVER_ROLE_ARN) */
  roleArn: string
  /** the sites distribution, the only caller of `live` (SITES_DISTRIBUTION_ARN) */
  distributionArn: string
  /** the egress connector's versioned ARN, for egress `none` (SERVER_NETWORK_CONNECTOR_ARN) */
  connectorArn?: string
  /** SERVERS_MAX_SITES and SERVER_ENVIRONMENTS, for the quota check */
  maxSites: number
  environments: number
}

export interface AwsSiteServersOptions {
  settings: AwsServersSettings
  functions: WebFunctionsApi
  zips: ServerZips
  blobs: Blobs
  logs: Pick<CloudWatchServerLogs, 'revisionOutput'>
  logEvents: Pick<LogEventsApi, 'retain' | 'deleteGroup' | 'groups'>
  runtime: () => Promise<ServerRuntime>
  /** for tests: time passing */
  sleep?: (ms: number) => Promise<void>
  /** how long a revision or endpoint may take to become Active (default 60 s) */
  activeWithinMs?: number
  /** how often its state is read meanwhile (default 1 s) */
  pollMs?: number
}

/** Environment names a site secret can't have: Lambda's, the entry's, PORT and HOST. */
const RESERVED_ENV = /^(AWS_|LAMBDA_|FLING_|_HANDLER$|_X_AMZN|PORT$|HOST$|TZ$|PATH$|LANG$)/

/** Arm vCPUs one environment takes. */
export const VCPUS_PER_ENVIRONMENT = 2
/** Lambda's bounds on a revision's timeout. */
const TIMEOUT_MIN = 3
const TIMEOUT_MAX = 900
/** The probe endpoint's settings: the least Lambda allows. */
const PROBE_SETTINGS: EndpointSettings = { rateLimit: 100, maxEnvironments: 2 }
/** Lambda keeps at most 50 revisions a function; past this many, those nothing routes to go. */
const REVISIONS_KEPT = 40
/** How long a failed probe waits, at most, for the server's first lines to reach CloudWatch. */
const PROBE_LOG_WAIT_MS = 8_000

/** Requests per second as a rateLimit Lambda accepts: 100 to 1000 by 100, then by 1000 to 10000. */
export function rateStep(rps: number): number {
  if (rps <= 100) return 100
  if (rps <= 1000) return Math.ceil(rps / 100) * 100
  return Math.min(10_000, Math.ceil(rps / 1000) * 1000)
}

/** Environments as a maxEnvironments Lambda accepts (2 to 10000). */
export const environmentsStep = (n: number) => Math.min(10_000, Math.max(2, Math.round(n)))

const sortedSecrets = (secrets: Record<string, string>) =>
  Object.fromEntries(Object.entries(secrets).sort(([a], [b]) => (a < b ? -1 : 1)))

const isWeighted = (weights: RevisionWeight[], revisionId: string) =>
  weights.some(w => w.revisionId === revisionId && w.weight > 0)

const newestFirst = (a: RevisionState, b: RevisionState) =>
  b.createdAt.getTime() - a.createdAt.getTime()

const startFailed = (message: string) =>
  new ApiError(422, 'server_failed_to_start', `Not published: ${message}`, { logs: [] })

export class AwsSiteServers implements SiteServers {
  /** the revision activate or reconfigure readied last, by site and version */
  private readonly readied = new Map<string, string>()
  /** each function's endpoint domains */
  private readonly domains = new Map<string, Record<string, string>>()
  private quotaChecked = false
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly o: AwsSiteServersOptions) {
    this.sleep = o.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  }

  private fn = (site: ServerSite) => functionName(this.o.settings.functionPrefix, site.id)
  private key = (site: ServerSite, version: ServerVersion) => `${site.id}/${version.id}`

  async activate(site: ServerSite, version: ServerVersion, opts: ServerOptions) {
    const revisionId = await this.ensureRevision(site, version, opts)
    this.readied.set(this.key(site, version), revisionId)
    return { target: await this.domain(this.fn(site), LIVE_ENDPOINT) }
  }

  async probe(
    site: ServerSite,
    version: ServerVersion,
    request: ProbeRequest
  ): Promise<ProbeResult> {
    const fn = this.fn(site)
    const revisionId = await this.revisionFor(site, version)
    if (!revisionId) return { ok: false, error: 'not activated', logs: [] }
    const started = Date.now()
    const deadline = started + request.timeoutMs
    let failure: string
    try {
      const domain = await this.pointProbe(fn, revisionId, deadline)
      failure = `no answer within ${request.timeoutMs / 1000} s`
      while (Date.now() < deadline) {
        const res = await this.o.functions.fetch(
          domain,
          new Request(`https://${domain}${request.path}`, {
            headers: { [SERVER_SITE_HEADER]: `${site.id}/${version.id}` },
          }),
          AbortSignal.timeout(Math.max(deadline - Date.now(), 1))
        )
        const stream = res.headers.get('lambda-web-logstream')
        if (stream && !stream.includes(revisionId)) {
          // the switch is still rolling out: that answer came from the revision before
          await res.body?.cancel()
          await this.sleep(250)
          continue
        }
        const platformError = res.headers.get('lambda-web-error-type')
        const marker = res.headers.get(SERVER_ERROR_HEADER)
        if (!platformError && !marker) {
          await res.body?.cancel()
          return { ok: true, status: res.status, logs: [] }
        }
        failure = marker ? await entryMessage(res) : `Lambda answered ${platformError}`
        if (platformError) await res.body?.cancel()
        break
      }
    } catch (err) {
      failure =
        err instanceof Error && err.name === 'TimeoutError'
          ? `no answer within ${request.timeoutMs / 1000} s`
          : err instanceof Error
            ? err.message
            : String(err)
    }
    const logs = await this.startLines(fn, revisionId, started, request.timeoutMs)
    return { ok: false, error: failure, logs }
  }

  async goLive(site: ServerSite, version: ServerVersion) {
    const fn = this.fn(site)
    const revisionId = await this.revisionFor(site, version)
    if (!revisionId) throw new Error(`Version ${version.id} of ${site.name} has no revision`)
    const live = await this.o.functions.getEndpoint(fn, LIVE_ENDPOINT)
    const only = live?.weights.length === 1 && live.weights[0]?.revisionId === revisionId
    if (!only) {
      await this.o.functions.updateEndpoint(fn, LIVE_ENDPOINT, {
        weights: [{ revisionId, weight: 100 }],
      })
    }
  }

  async reconfigure(site: ServerSite, version: ServerVersion, opts: ServerOptions) {
    const target = await this.activate(site, version, opts)
    await this.goLive(site, version)
    return target
  }

  async setEnabled(site: ServerSite, enabled: boolean) {
    const fn = this.fn(site)
    const found = await this.o.functions.getFunction(fn)
    if (!found) return
    const tags = await this.o.functions.tags(found.arn)
    const stopped = tags[TAG_STOPPED] === '1'
    if (stopped === !enabled) return
    await this.o.functions.tag(found.arn, { [TAG_STOPPED]: enabled ? '0' : '1' })
    await this.o.functions.updateEndpoint(fn, LIVE_ENDPOINT, {
      rateLimit: enabled ? Number(tags[TAG_RATE] ?? PROBE_SETTINGS.rateLimit) : 0,
    })
  }

  async retire(site: ServerSite, version?: ServerVersion) {
    const fn = this.fn(site)
    if (!version) {
      await this.forgetFunction(fn, site.id)
      return
    }
    this.readied.delete(this.key(site, version))
    const revisions = await this.o.functions.listRevisions(fn)
    const mine = revisions.filter(r => parseRevisionLabel(r.description)?.versionId === version.id)
    if (mine.length === 0) {
      await this.o.zips.deletePrefix(zipKey(site.id, version.id))
      return
    }
    const others = revisions
      .filter(r => !mine.includes(r) && r.state === 'Active')
      .sort(newestFirst)
    for (const endpoint of [LIVE_ENDPOINT, PROBE_ENDPOINT]) {
      const e = await this.o.functions.getEndpoint(fn, endpoint)
      if (!e || !mine.some(r => isWeighted(e.weights, r.revisionId))) continue
      // The version is gone, so nothing may be routed to it: only another version's revision, or
      // none at all (the version was the site's last server, and the function goes).
      const next = others[0]
      if (!next) {
        await this.forgetFunction(fn, site.id)
        return
      }
      await this.o.functions.updateEndpoint(fn, endpoint, {
        weights: [{ revisionId: next.revisionId, weight: 100 }],
      })
      await this.waitEndpoint(fn, endpoint)
    }
    for (const r of mine) await this.o.functions.deleteRevision(fn, r.revisionId)
    await this.o.zips.deletePrefix(zipKey(site.id, version.id))
  }

  async invoke(site: ServerSite, version: ServerVersion, request: Request): Promise<Response> {
    const fn = this.fn(site)
    const found = await this.o.functions.getFunction(fn)
    const revisionId = found ? await this.revisionFor(site, version) : null
    if (!found || !revisionId) return gatewayError(404, 'server_not_found', 'No such server')
    const tags = await this.o.functions.tags(found.arn)
    if (tags[TAG_STOPPED] === '1') return gatewayError(503, 'server_stopped', 'Server stopped')
    const live = await this.o.functions.getEndpoint(fn, LIVE_ENDPOINT)
    const domain =
      live && isWeighted(live.weights, revisionId)
        ? live.domainName
        : await this.pointProbe(fn, revisionId, Date.now() + 30_000)
    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    headers.set('x-forwarded-host', url.host)
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''))
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const res = await this.o.functions.fetch(
      domain,
      new Request(`https://${domain}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: hasBody ? request.body : null,
        ...(hasBody ? { duplex: 'half' } : {}),
      } as RequestInit)
    )
    const out = new Headers(res.headers)
    for (const name of [...out.keys()]) if (name.startsWith('lambda-web-')) out.delete(name)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
  }

  /**
   * The hourly sweep: every function of this instance whose site is gone (deleted while a delete
   * failed halfway, or created by a publish that never finished) is deleted, and every server log
   * group whose function is gone (Lambda writes them again after a delete). `exists` says whether
   * the site with this id and name is still there. Returns how many of each it deleted.
   */
  async sweep(exists: (siteId: string, name: string) => Promise<boolean>) {
    const { functionPrefix } = this.o.settings
    const functions = await this.o.functions.listFunctions(functionPrefix)
    let deleted = 0
    const kept = new Set<string>()
    for (const f of functions) {
      const siteId = siteIdOf(functionPrefix, f.name)
      const tags = await this.o.functions.tags(f.arn)
      const name = tags[TAG_SITE]
      if (!siteId || !name || tags[TAG_INSTANCE] !== this.o.settings.instance) {
        kept.add(f.name)
        continue
      }
      if (await exists(siteId, name)) {
        kept.add(f.name)
        continue
      }
      await this.forgetFunction(f.name, siteId)
      deleted++
    }
    let groups = 0
    for (const group of await this.o.logEvents.groups(`${LOG_GROUP_PREFIX}${functionPrefix}`)) {
      const fn = group.slice(LOG_GROUP_PREFIX.length).replace(/\.local$/, '')
      if (kept.has(fn)) continue
      await this.o.logEvents.deleteGroup(group)
      groups++
    }
    return { functions: deleted, logGroups: groups }
  }

  // ---------------------------------------------------------------------------------------------

  /** The revision a version runs with these options: found by its label, or made and waited for. */
  private async ensureRevision(site: ServerSite, version: ServerVersion, opts: ServerOptions) {
    const { settings } = this.o
    if (opts.egress === 'none' && !settings.connectorArn) {
      throw new ApiError(
        409,
        'servers_egress_unavailable',
        "This Fling's site servers are to reach nothing outside (SERVERS_EGRESS=none), and its AWS deployment has no egress network connector: an admin turns on the connector (Terraform servers.egress) or sets SERVERS_EGRESS=open"
      )
    }
    const fn = this.fn(site)
    const key = zipKey(site.id, version.id)
    const zipVersion = (await this.o.zips.find(key)) ?? (await this.putZip(site, version, key))
    const spec = this.revisionSpec(version, opts, {
      bucket: this.o.zips.bucket,
      key,
      versionId: zipVersion,
    })
    const found = await this.o.functions.getFunction(fn)
    if (!found) return this.createFunction(site, fn, spec, opts)

    await this.applyLimits(fn, found.arn, opts)
    const revisions = await this.o.functions.listRevisions(fn)
    const same = revisions.find(r => r.description === spec.description && r.state !== 'Failed')
    if (same) {
      if (same.state !== 'Active') await this.waitActive(fn, same.revisionId)
      return same.revisionId
    }
    await this.prune(fn, version, revisions)
    const revisionId = await this.o.functions.createRevision(fn, spec)
    await this.waitActive(fn, revisionId)
    return revisionId
  }

  private revisionSpec(
    version: ServerVersion,
    opts: ServerOptions,
    zip: RevisionSpec['zip']
  ): RevisionSpec {
    const { settings } = this.o
    const reserved = Object.keys(opts.secrets).filter(name => RESERVED_ENV.test(name))
    if (reserved.length > 0) {
      throw new ApiError(
        400,
        'invalid_secret_name',
        `On this Fling a site secret can't be called ${reserved.join(', ')}: AWS_*, LAMBDA_*, FLING_*, PORT, HOST and _HANDLER are the platform's. Rename it in fling.json and set it again`,
        { secrets: reserved }
      )
    }
    const secrets = sortedSecrets(opts.secrets)
    const environment: Record<string, string> = {
      ...secrets,
      [ENTRY_ENV.version]: version.id,
      [ENTRY_ENV.secretNames]: Object.keys(secrets).join(','),
      [ENTRY_ENV.timeoutSeconds]: String(opts.limits.timeoutSeconds),
      [ENTRY_ENV.bodyBytes]: String(opts.limits.bodyBytes),
    }
    const timeoutSeconds = Math.min(
      TIMEOUT_MAX,
      Math.max(TIMEOUT_MIN, Math.ceil(opts.limits.timeoutSeconds))
    )
    const connectorArn = opts.egress === 'none' ? settings.connectorArn : undefined
    const hash = createHash('sha256')
      .update(
        JSON.stringify({ zip, environment, timeoutSeconds, connectorArn, role: settings.roleArn })
      )
      .digest('hex')
      .slice(0, 16)
    return {
      description: revisionLabel(version.id, hash),
      zip,
      roleArn: settings.roleArn,
      timeoutSeconds,
      environment,
      ...(connectorArn ? { connectorArn } : {}),
    }
  }

  private async putZip(site: ServerSite, version: ServerVersion, key: string) {
    const { zip, skipped } = await revisionZip(this.o.blobs, await this.o.runtime(), site, version)
    if (skipped > 0) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'server zip: files left out',
          site: site.name,
          version: version.id,
          skipped,
        })
      )
    }
    return this.o.zips.put(key, zip)
  }

  private endpointSettings(opts: ServerOptions): EndpointSettings {
    return {
      rateLimit: rateStep(opts.limits.rps),
      maxEnvironments: environmentsStep(opts.limits.environments),
    }
  }

  private async createFunction(
    site: ServerSite,
    fn: string,
    revision: RevisionSpec,
    opts: ServerOptions
  ) {
    await this.checkQuota(opts)
    const settings = this.endpointSettings(opts)
    const created = await this.o.functions.createFunction({
      name: fn,
      tags: {
        [TAG_INSTANCE]: this.o.settings.instance,
        [TAG_SITE]: site.name,
        [TAG_RATE]: String(settings.rateLimit),
        [TAG_STOPPED]: '0',
      },
      revision,
      endpoint: { name: LIVE_ENDPOINT, ...settings },
    })
    await this.o.functions.putResourcePolicy(created.arn, this.resourcePolicy(created.arn))
    for (const group of logGroupsOf(fn)) await this.o.logEvents.retain(group, LOG_RETENTION_DAYS)
    await this.waitActive(fn, created.revisionId)
    const probe = await this.o.functions.createEndpoint(fn, {
      name: PROBE_ENDPOINT,
      weights: [{ revisionId: created.revisionId, weight: 100 }],
      ...PROBE_SETTINGS,
    })
    this.domains.set(fn, {
      [LIVE_ENDPOINT]: created.domainName,
      [PROBE_ENDPOINT]: probe.domainName,
    })
    await this.waitEndpoint(fn, LIVE_ENDPOINT)
    await this.waitEndpoint(fn, PROBE_ENDPOINT)
    return created.revisionId
  }

  /** Only the sites distribution may invoke the live endpoint. */
  private resourcePolicy(functionArn: string) {
    return JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'SitesDistributionInvokesLive',
          Effect: 'Allow',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Action: 'lambda:InvokeWebFunctionEndpoint',
          Resource: `${functionArn}/endpoint/${LIVE_ENDPOINT}`,
          Condition: { StringEquals: { 'aws:SourceArn': this.o.settings.distributionArn } },
        },
      ],
    })
  }

  /** The live endpoint's rate and environments follow the site's limits (a stopped one stays at 0). */
  private async applyLimits(fn: string, arn: string, opts: ServerOptions) {
    const want = this.endpointSettings(opts)
    const tags = await this.o.functions.tags(arn)
    if (tags[TAG_RATE] !== String(want.rateLimit)) {
      await this.o.functions.tag(arn, { [TAG_RATE]: String(want.rateLimit) })
    }
    const live = await this.o.functions.getEndpoint(fn, LIVE_ENDPOINT)
    if (!live) return
    const rateLimit = tags[TAG_STOPPED] === '1' ? 0 : want.rateLimit
    if (live.rateLimit !== rateLimit || live.maxEnvironments !== want.maxEnvironments) {
      await this.o.functions.updateEndpoint(fn, LIVE_ENDPOINT, {
        rateLimit,
        maxEnvironments: want.maxEnvironments,
      })
    }
  }

  /**
   * Before a new revision of `version`: its other revisions that nothing routes to go (they run
   * superseded secrets or limits), and the oldest of any version past REVISIONS_KEPT.
   */
  private async prune(fn: string, version: ServerVersion, revisions: RevisionState[]) {
    const live = (await this.o.functions.getEndpoint(fn, LIVE_ENDPOINT))?.weights ?? []
    const idle = revisions.filter(r => !isWeighted(live, r.revisionId))
    const superseded = idle.filter(
      r => parseRevisionLabel(r.description)?.versionId === version.id || r.state === 'Failed'
    )
    const rest = idle.filter(r => !superseded.includes(r)).sort(newestFirst)
    const excess = revisions.length - superseded.length - REVISIONS_KEPT
    const oldest = excess > 0 ? rest.slice(Math.max(0, rest.length - excess)) : []
    const doomed = [...superseded, ...oldest]
    if (doomed.length === 0) return
    // The probe endpoint only ever carries the start probe: it moves to what is live.
    const probe = await this.o.functions.getEndpoint(fn, PROBE_ENDPOINT)
    if (probe && doomed.some(r => isWeighted(probe.weights, r.revisionId))) {
      if (live.length === 0) return
      await this.o.functions.updateEndpoint(fn, PROBE_ENDPOINT, { weights: live })
      await this.waitEndpoint(fn, PROBE_ENDPOINT)
    }
    for (const r of doomed) await this.o.functions.deleteRevision(fn, r.revisionId)
  }

  private async checkQuota(opts: ServerOptions) {
    if (this.quotaChecked) return
    const { maxSites } = this.o.settings
    const environments = Math.max(
      environmentsStep(this.o.settings.environments),
      environmentsStep(opts.limits.environments)
    )
    const need = maxSites * environments * VCPUS_PER_ENVIRONMENT
    const quota = await this.o.functions.maxArmVCpus()
    if (need > quota) {
      throw new ApiError(
        409,
        'servers_quota',
        `This Fling may run ${maxSites} site servers of up to ${environments} environments (${VCPUS_PER_ENVIRONMENT} vCPU each: ${need} vCPU), and its AWS account allows ${quota} Arm vCPUs for Web Functions: an admin lowers SERVERS_MAX_SITES or SERVER_ENVIRONMENTS, or asks AWS for more`
      )
    }
    this.quotaChecked = true
  }

  /** The revision activate readied for the version, or its newest Active one. */
  private async revisionFor(site: ServerSite, version: ServerVersion): Promise<string | null> {
    const known = this.readied.get(this.key(site, version))
    if (known) return known
    const revisions = await this.o.functions.listRevisions(this.fn(site))
    const newest = revisions
      .filter(
        r => r.state === 'Active' && parseRevisionLabel(r.description)?.versionId === version.id
      )
      .sort(newestFirst)[0]
    return newest?.revisionId ?? null
  }

  /** Point the probe endpoint at the revision (if it isn't already) and wait for the change. */
  private async pointProbe(fn: string, revisionId: string, deadline: number) {
    const probe = await this.o.functions.getEndpoint(fn, PROBE_ENDPOINT)
    if (!probe) throw new Error(`${fn} has no ${PROBE_ENDPOINT} endpoint`)
    const only = probe.weights.length === 1 && probe.weights[0]?.revisionId === revisionId
    if (!only) {
      await this.o.functions.updateEndpoint(fn, PROBE_ENDPOINT, {
        weights: [{ revisionId, weight: 100 }],
      })
      await this.waitEndpoint(fn, PROBE_ENDPOINT, deadline)
    }
    return probe.domainName
  }

  private async domain(fn: string, endpoint: string) {
    const known = this.domains.get(fn)?.[endpoint]
    if (known) return known
    const e = await this.o.functions.getEndpoint(fn, endpoint)
    if (!e) throw new Error(`${fn} has no ${endpoint} endpoint`)
    this.domains.set(fn, { ...this.domains.get(fn), [endpoint]: e.domainName })
    return e.domainName
  }

  private async waitActive(fn: string, revisionId: string) {
    const until = Date.now() + (this.o.activeWithinMs ?? 60_000)
    for (;;) {
      const r = await this.o.functions.getRevision(fn, revisionId)
      if (r?.state === 'Active') return
      if (!r || r.state === 'Failed') {
        throw startFailed(
          `Lambda could not make the server's revision ${revisionId} (${r?.stateReason ?? 'it is gone'})`
        )
      }
      if (Date.now() >= until) {
        throw startFailed(
          `the server's revision ${revisionId} wasn't ready within ${(this.o.activeWithinMs ?? 60_000) / 1000} s`
        )
      }
      await this.sleep(this.o.pollMs ?? 1000)
    }
  }

  private async waitEndpoint(fn: string, endpoint: string, deadline?: number) {
    const until = deadline ?? Date.now() + (this.o.activeWithinMs ?? 60_000)
    for (;;) {
      const e = await this.o.functions.getEndpoint(fn, endpoint)
      if (e && e.state === 'Active' && !e.updating) return
      if (e?.state === 'Failed') throw new Error(`The ${endpoint} endpoint of ${fn} failed`)
      if (Date.now() >= until) throw new Error(`The ${endpoint} endpoint of ${fn} isn't ready`)
      await this.sleep(Math.min(this.o.pollMs ?? 1000, 250))
    }
  }

  /** What the revision printed first, once CloudWatch has it (a little while after the probe). */
  private async startLines(fn: string, revisionId: string, started: number, timeoutMs: number) {
    const since = new Date(started - 5_000)
    const until = Date.now() + Math.min(PROBE_LOG_WAIT_MS, Math.max(1000, timeoutMs / 2))
    for (;;) {
      const lines = await this.o.logs
        .revisionOutput(fn, revisionId, since, SERVER_START_LOG_LINES)
        .catch(() => [])
      if (lines.length > 0 || Date.now() >= until) return lines
      await this.sleep(1000)
    }
  }

  private async forgetFunction(fn: string, siteId: string) {
    await this.o.functions.deleteFunction(fn)
    for (const group of logGroupsOf(fn)) await this.o.logEvents.deleteGroup(group)
    await this.o.zips.deletePrefix(`${siteId}/`)
    this.domains.delete(fn)
    for (const k of [...this.readied.keys()]) if (k.startsWith(`${siteId}/`)) this.readied.delete(k)
  }
}

/** The message of an answer the entry gave for the author's server (SERVER_ERROR_HEADER). */
async function entryMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    return body.error?.message ?? `the entry answered ${res.status}`
  } catch {
    return `the entry answered ${res.status}`
  }
}

const gatewayError = (status: number, code: string, message: string) =>
  Response.json(
    { error: { code, message } },
    { status, headers: { 'cache-control': 'private, no-store' } }
  )
