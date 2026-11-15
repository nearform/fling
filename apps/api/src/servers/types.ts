/**
 * The ports a platform implements to run site servers: `SiteServers` (ready a version's server,
 * probe it, hand it the site's requests, run it, retire it) and `ServerLogs` (keep and read what
 * servers print and the request log Fling writes for every invoke).
 *
 * Going live is activate (ready the version, returning the route value's `t`), probe (the core
 * judges the answer), then `goLive`, only on a platform whose edge reaches one place for every
 * version (AWS: the live endpoint's revision weights move to the probed revision); then the core
 * writes the route. Where the route value itself names what runs (Cloudflare's run, the local
 * runtime's version), the route is the switch and `goLive` is absent. The core decides everything else, once (servers/index.ts):
 * admission, the server mark, the route flag, secrets, the start probe's rules, policy, limits.
 *
 * A site server is the version's `_fling/server.mjs` (SERVER_BUNDLE): one ES module that imports
 * only `node:*` and Fling's helpers, either a fetch handler (`export default { fetch }`) or a plain
 * Node server (`http.createServer(…).listen(process.env.PORT)`). Every adapter runs both, gives it
 * its site secrets as `process.env.NAME` (and `env.NAME` where the runtime passes an env), and
 * keeps one site's server away from every other site, the instance's credentials and Fling's
 * storage. The conformance suites (packages/conformance: siteServersSuite, serverLogsSuite) are
 * the contract.
 */
import type { ServerLogLine, SiteViewer } from '@fling/shared/site-server'
import type { ServerLimits } from '../config.ts'

export type { ServerLogLine }

/** The site a server belongs to. */
export interface ServerSite {
  /** the site's id: its storage prefix `sites/<id>/` */
  id: string
  name: string
}

/** The version whose server it is. */
export interface ServerVersion {
  /** the version's id */
  id: string
  /** the bundle's object key in Blobs: `sites/<siteId>/<versionId>/_fling/server.mjs` */
  bundle: string
  /** the prefix of the version's files in Blobs (`sites/<siteId>/<versionId>/`), for `file()` */
  files: string
}

/** How a server runs: what activate and reconfigure are given. */
export interface ServerOptions {
  /** the site's secrets, by name: only those the version declares (`fling.json` `secrets`) */
  secrets: Record<string, string>
  /** what it may reach (`SERVERS_EGRESS`): nothing outside, or the internet */
  egress: 'none' | 'open'
  /** the instance's limits, with any an admin raised for this site */
  limits: ServerLimits
}

/** The one request of a start probe, sent straight to a version's server before it is live. */
export interface ProbeRequest {
  method: 'GET'
  /** a path under SERVER_PREFIX: the version's health path, or SERVER_PREFIX itself */
  path: string
  /** how long to wait for an answer */
  timeoutMs: number
}

/**
 * What a start probe saw: an HTTP answer (any status), or none (the server crashed, listened on
 * nothing, or was silent until the timeout), with the first lines it printed either way.
 */
export type ProbeResult =
  | { ok: true; status: number; logs: string[] }
  | { ok: false; error: string; logs: string[] }

export interface SiteServers {
  /**
   * The longest time per request the platform can serve, in seconds, when it is less than
   * SERVER_TIMEOUT_SECONDS allows (AWS: 120, CloudFront's wait on an origin). The core runs no
   * server with a longer limit (`limitsOf`) and refuses an admin's raise past it.
   */
  readonly maxTimeoutSeconds?: number
  /**
   * Ready a version's server to be probed and go live. Idempotent: activating a version that is
   * ready already (a rollback) costs nothing more. Returns what the route value carries for the
   * sites host (`t`), or null when it needs nothing. AWS: the zip, the revision, waiting for it to
   * be Active, and the live endpoint's domain as the target, where CloudFront sends the request;
   * Cloudflare: the options sealed into R2 and the run's name (a keyed hash of them) as the target,
   * which the sites host loads the isolate by; the local runtime: null.
   */
  activate(
    site: ServerSite,
    version: ServerVersion,
    opts: ServerOptions
  ): Promise<{ target: string | null }>
  /** The start probe: one request to this version's server, before the route points at it. */
  probe(site: ServerSite, version: ServerVersion, request: ProbeRequest): Promise<ProbeResult>
  /**
   * The version's server takes the site's requests, once its start probe passed and before the
   * route changes. Only for a platform whose edge reaches one place for every version (AWS: the
   * live endpoint's revision weights); where the route value names the version, the route is the
   * switch and there is nothing to do.
   */
  goLive?(site: ServerSite, version: ServerVersion): Promise<void>
  /**
   * The live version's options changed (a secret set or removed, an admin's limits): it runs with
   * these from now on, at the target it returns (the core rewrites `t` when it moved). Cloudflare:
   * a fresh isolate, under a new run name; AWS: a new revision of the same version, live at once.
   */
  reconfigure(
    site: ServerSite,
    version: ServerVersion,
    opts: ServerOptions
  ): Promise<{ target: string | null }>
  /** The site's server stops (an admin's kill switch, archiving) or runs again. */
  setEnabled(site: ServerSite, enabled: boolean): Promise<void>
  /** Forget a version's server (retention), or all of the site's (deleting it). */
  retire(site: ServerSite, version?: ServerVersion): Promise<void>
  /**
   * Run a request through a version's server, as the sites host does for an invoke: `request` is
   * the one the server gets (serverRequestHeaders: no cookies, VIEWER_HEADER set). Platforms whose
   * edge reaches the server itself (AWS: CloudFront to the Web Function) implement it for the
   * conformance suites and diagnostics.
   */
  invoke(site: ServerSite, version: ServerVersion, request: Request): Promise<Response>
}

/**
 * A site's server log: Fling's request line for every invoke and what the server printed, each
 * naming its version, kept SERVER_LOG_DAYS. `append` is for adapters whose platform does not
 * collect output itself (the local runtime, a Worker's tail consumer); on AWS CloudWatch has it
 * already.
 */
export interface ServerLogs {
  append?(siteId: string, lines: ServerLogLine[]): Promise<void>
  /** Lines at or after `since`, oldest first, at most `limit`. */
  read(siteId: string, since: Date, limit: number): Promise<ServerLogLine[]>
}

/** What the core needs from the request log of one invoke (logInvoke, servers/logs.ts). */
export interface InvokeRecord {
  siteId: string
  versionId: string
  method: string
  path: string
  status: number
  ms: number
  viewer: SiteViewer | null
}
