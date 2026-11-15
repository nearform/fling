// Site servers: the contracts every runtime that runs one shares, beside the routing decision
// (site-routing.ts, which decides `invoke`). A site server is one bundled ES module,
// `_fling/server.mjs` of a version, run for `/api/*` of the site's host. What the author's
// `fling.json` says about it (ServerConfigSchema) travels with the deploy, never as a file.
//
// Not for the CloudFront Function: these use Web APIs that runtime lacks. The shells that run a
// server (the Worker, the local runtime, the AWS entry) use them.

import { z } from 'zod'
import { CLI_PACKAGE } from './distribution.ts'
import { SERVER_PREFIX, SERVER_SITE_HEADER, VIEWER_HEADER } from './route-keys.ts'
import { type SiteInvoke, type SiteViewer, serverSiteHeader } from './site-routing.ts'

export type { SiteViewer }

/** The file at the top of a deployed folder that says how its server runs: a build input. */
export const SERVER_CONFIG_FILE = 'fling.json'
/** The largest bundle a version may carry, in bytes. */
export const SERVER_BUNDLE_MAX_BYTES = 5 * 1024 * 1024
/** The most site secrets one site may have. */
export const SITE_SECRETS_MAX = 20
/** The largest value one site secret may have, in bytes (UTF-8). */
export const SITE_SECRET_MAX_BYTES = 8 * 1024
/** A site secret's name: what the server reads as `process.env.NAME`. */
export const SITE_SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/
/**
 * The names a site secret can't have, on every platform: what a server's runtime sets beside the
 * secrets (Lambda's `AWS_*`, `LAMBDA_*`, `_X_AMZN*` and `_HANDLER`; Fling's `FLING_*`, `PORT`,
 * `HOST` and Cloudflare's `FILES` binding; the process's `PATH`, `TZ` and `LANG`). One list, so a
 * site moves between platforms with its secrets.
 */
export const RESERVED_SECRET_NAMES = {
  prefixes: ['AWS_', 'LAMBDA_', 'FLING_', '_X_AMZN'],
  names: ['PORT', 'HOST', 'PATH', 'TZ', 'LANG', '_HANDLER', 'FILES'],
} as const
/** The reserved names, as people read them (`AWS_*, …, FILES`). */
export const RESERVED_SECRET_NAMES_TEXT = [
  ...RESERVED_SECRET_NAMES.prefixes.map(p => `${p}*`),
  ...RESERVED_SECRET_NAMES.names,
].join(', ')
/** A name a runtime sets itself, so not one a site secret may have (RESERVED_SECRET_NAMES). */
export const isReservedSecretName = (name: string) =>
  RESERVED_SECRET_NAMES.prefixes.some(p => name.startsWith(p)) ||
  (RESERVED_SECRET_NAMES.names as readonly string[]).includes(name)
/** How long a start probe waits for the new version's server to answer, in milliseconds. */
export const SERVER_PROBE_TIMEOUT_MS = 10_000
/** The path the start probe asks when `fling.json` names no health path: any answer will do. */
export const SERVER_PROBE_DEFAULT_PATH = SERVER_PREFIX
/** How many of the server's log lines a failed start reports. */
export const SERVER_START_LOG_LINES = 20
/** How long a site's server log is kept, in days. */
export const SERVER_LOG_DAYS = 7
/** The module a server imports for Fling's helpers (the CLI package's `/server` sub-path). */
export const SERVER_HELPER_SUFFIX = '/server'
/** The module specifier a server imports Fling's helpers by: the CLI package's `/server`. */
export const SERVER_HELPER_MODULE = `${CLI_PACKAGE}${SERVER_HELPER_SUFFIX}`

/** A site secret's name, checked. */
export const SiteSecretNameSchema = z
  .string()
  .regex(
    SITE_SECRET_NAME_RE,
    'A secret name is A-Z, 0-9 and _, not starting with a digit, at most 64'
  )

/**
 * `fling.json` as the deploy sends it (`DeployRequest.server`): the site secrets the server needs
 * (a publish or rollback to it is refused until they are all set), and the path the start probe
 * asks, which must answer 2xx. `server` (the entry the CLI bundles) stays on the author's machine.
 */
export const ServerConfigSchema = z.object({
  secrets: z.array(SiteSecretNameSchema).max(SITE_SECRETS_MAX).default([]),
  health: z
    .string()
    .max(200)
    .refine(p => p.startsWith(SERVER_PREFIX), `The health path is under ${SERVER_PREFIX}`)
    .optional(),
})
export type ServerConfig = z.infer<typeof ServerConfigSchema>

/** A site secret as the API lists it: never its value. */
export const SiteSecretSchema = z.object({
  name: z.string(),
  setBy: z.string(),
  setAt: z.string(),
})
export type SiteSecret = z.infer<typeof SiteSecretSchema>

/**
 * GET /api/sites/:name/secrets. `declared`: the names the live version's `fling.json` declares,
 * set or not (`missing`: those not set). `waiting`: the version waiting for secrets, when there is
 * one, with the names its `fling.json` declares and those still unset (none: its server failed to
 * start, and the next change tries it again).
 */
export const SiteSecretsResponseSchema = z.object({
  secrets: z.array(SiteSecretSchema),
  declared: z.array(z.string()),
  missing: z.array(z.string()),
  waiting: z
    .object({
      versionId: z.string(),
      declared: z.array(z.string()),
      missing: z.array(z.string()),
    })
    .optional(),
})
export type SiteSecretsResponse = z.infer<typeof SiteSecretsResponseSchema>

/**
 * The live version's server after a secret changed: it runs with the site's secrets as they are
 * now, and answered its start probe (`ok`), or didn't (`server_failed_to_start`: that version is
 * still the one serving, with the new secrets, and its log says why).
 */
export const SecretLiveOutcomeSchema = z.union([
  z.object({ versionId: z.string(), ok: z.literal(true) }),
  z.object({
    versionId: z.string(),
    ok: z.literal(false),
    error: z.literal('server_failed_to_start'),
    message: z.string(),
    logs: z.array(z.string()),
  }),
])
export type SecretLiveOutcome = z.infer<typeof SecretLiveOutcomeSchema>

/**
 * The publish that waited for secrets, once none is unset: live at `url`, or refused (`error`: the
 * code a publish would give, e.g. `server_failed_to_start` with the server's log). Refused because
 * its server didn't start, it still waits, and the next secret set or removed tries it again;
 * refused for anything else, it waits no more: publish again.
 */
export const SecretDeployedOutcomeSchema = z.union([
  z.object({ versionId: z.string(), url: z.string() }),
  z.object({
    versionId: z.string(),
    error: z.string(),
    message: z.string(),
    logs: z.array(z.string()).optional(),
  }),
])
export type SecretDeployedOutcome = z.infer<typeof SecretDeployedOutcomeSchema>

/**
 * PUT /api/sites/:name/secrets/:secret: the secret as listed, and what setting it did. `live`: the
 * live server reconfigured and probed (a site whose live version has a server). `deployed`: the
 * publish that waited for secrets went live, or was refused. `missing`: that publish still waits
 * for these.
 */
export const PutSiteSecretResponseSchema = SiteSecretSchema.extend({
  live: SecretLiveOutcomeSchema.optional(),
  deployed: SecretDeployedOutcomeSchema.optional(),
  missing: z.array(z.string()).optional(),
})
export type PutSiteSecretResponse = z.infer<typeof PutSiteSecretResponseSchema>

/**
 * DELETE /api/sites/:name/secrets/:secret: the name removed, the live server after it, and the
 * waiting publish tried again (as after a set).
 */
export const DeleteSiteSecretResponseSchema = z.object({
  name: z.string(),
  live: SecretLiveOutcomeSchema.optional(),
  deployed: SecretDeployedOutcomeSchema.optional(),
  missing: z.array(z.string()).optional(),
})
export type DeleteSiteSecretResponse = z.infer<typeof DeleteSiteSecretResponseSchema>

/** The limits one site's server runs with (the instance's `SERVER_*`, or an admin's raise). */
export const ServerLimitsSchema = z.object({
  /** wall time per request, streams included */
  timeoutSeconds: z.number(),
  /** CPU per request, where the platform measures it */
  cpuMs: z.number(),
  /** requests per second to the site */
  rps: z.number(),
  /** environments the site may run at once, where the platform has them */
  environments: z.number(),
  /** the largest request body */
  bodyBytes: z.number(),
})
export type ServerLimits = z.infer<typeof ServerLimitsSchema>

/**
 * A site's server as its site page shows it (`SiteDetail.server`, while the current version has
 * one): whether an admin stopped it (`/api/*` answers 503), the limits it runs with, and those an
 * admin raised for it (the rest are the instance's).
 */
export const SiteServerSchema = z.object({
  stopped: z.boolean(),
  limits: ServerLimitsSchema,
  raised: ServerLimitsSchema.partial(),
})
export type SiteServer = z.infer<typeof SiteServerSchema>

/** PUT /api/admin/sites/:name/server answers the site's server as it now is. */
export const AdminServerStateSchema = SiteServerSchema.extend({
  name: z.string(),
  hasServer: z.boolean(),
})
export type AdminServerState = z.infer<typeof AdminServerStateSchema>

/** PUT /api/sites/:name/secrets/:secret */
export const PutSiteSecretRequestSchema = z.object({ value: z.string() })

/**
 * One line of a site's server log: `request`, the line Fling writes for every invoke (method,
 * path, status, duration, viewer id, version); `output`, a line the server printed (`level`).
 */
export const ServerLogLineSchema = z.object({
  at: z.string(),
  versionId: z.string(),
  kind: z.enum(['request', 'output']),
  method: z.string().optional(),
  path: z.string().optional(),
  status: z.number().int().optional(),
  ms: z.number().optional(),
  /** the viewer id, or null with no viewer (a public site, a share link) */
  viewer: z.string().nullable().optional(),
  level: z.enum(['info', 'error']).optional(),
  text: z.string().optional(),
})
export type ServerLogLine = z.infer<typeof ServerLogLineSchema>

/** GET /api/sites/:name/logs */
export const ServerLogsResponseSchema = z.object({ lines: z.array(ServerLogLineSchema) })
export type ServerLogsResponse = z.infer<typeof ServerLogsResponseSchema>

/** One request-log line, as `fling logs` prints it. */
export function formatLogLine(line: ServerLogLine): string {
  const time = line.at.slice(11, 19)
  if (line.kind === 'output') return `${time}  ${line.text ?? ''}`
  return [
    time,
    `${line.method} ${line.path}`,
    String(line.status),
    `${Math.round(line.ms ?? 0)} ms`,
    line.viewer ?? '-',
    `version ${line.versionId}`,
  ].join('  ')
}

/**
 * The viewer a server was given, from VIEWER_HEADER's value: `{ id, email, guest }`, or null
 * when there is none or it isn't one (a server is never sent a malformed one; a browser's never
 * reaches it).
 */
export function parseViewerHeader(value: string | null | undefined): SiteViewer | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as Partial<SiteViewer> | null
    if (!v || typeof v.id !== 'string' || typeof v.email !== 'string') return null
    return { id: v.id, email: v.email, guest: v.guest === true }
  } catch {
    return null
  }
}

/** Request headers a server never sees from the browser: its credentials and a forged viewer. */
const DROPPED = ['cookie', 'authorization', VIEWER_HEADER, SERVER_SITE_HEADER]

/** SERVER_SITE_HEADER read back (site-routing.ts serverSiteHeader); null when it isn't one. */
export function parseServerSiteHeader(
  value: string | null | undefined
): { siteId: string; v: string; private: boolean } | null {
  const parts = (value ?? '').split('/')
  const [siteId, v, flag] = parts
  if (!siteId || !v || parts.length > 3 || (flag !== undefined && flag !== 'private')) return null
  return { siteId, v, private: flag === 'private' }
}

/**
 * The request a site's server gets for an invoke: the browser's, without its cookies,
 * credentials or any VIEWER_HEADER, with VIEWER_HEADER set from the decision and
 * SERVER_SITE_HEADER (serverSiteHeader).
 */
export function serverRequestHeaders(
  headers: Headers,
  decision: Pick<SiteInvoke, 'siteId' | 'v' | 'viewer' | 'private'>
): Headers {
  const out = new Headers(headers)
  for (const name of DROPPED) out.delete(name)
  if (decision.viewer) out.set(VIEWER_HEADER, JSON.stringify(decision.viewer))
  out.set(SERVER_SITE_HEADER, serverSiteHeader(decision))
  return out
}

/**
 * The Cache-Control a server's response goes out with: the author's, for the browser (no edge
 * caches it: every request reaches the server after the access checks), but `private` in place of
 * `public` on a site that isn't public, and `private, no-store` when the author set none.
 */
export function serverCacheControl(
  author: string | null | undefined,
  privateSite: boolean
): string {
  const value = (author ?? '').trim()
  if (!value) return 'private, no-store'
  if (!privateSite) return value
  return value
    .split(',')
    .map(d => d.trim())
    .filter(d => d && !/^s-maxage=/i.test(d) && !/^proxy-revalidate$/i.test(d))
    .map(d => (d.toLowerCase() === 'public' ? 'private' : d))
    .join(', ')
}

/**
 * What a server may import, besides itself: Node's built-ins (`node:*`) and Fling's helpers
 * (`<CLI package>/server`). Anything else is an npm package or a file the bundle should have
 * inlined (400 `server_not_bundled`).
 */
export function allowedServerImport(specifier: string, helperModule: string): boolean {
  return specifier.startsWith('node:') || specifier === helperModule
}

// `import … from "x"`, `import "x"`, `export … from "x"`, `import("x")`, `require("x")`, where the
// keyword starts a statement or an expression (so most text in strings isn't taken for one).
const IMPORT_RES = [
  /(?:^|[\s;{}()])import\s*(?:[\w$*{},\s]+?\s*from\s*)?["']([^"'\n]+)["']/g,
  /(?:^|[\s;{}()])export\s*[\w$*{},\s]*?\s*from\s*["']([^"'\n]+)["']/g,
  /(?:^|[^\w$.])import\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /(?:^|[^\w$.])require\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
]

/**
 * The modules a bundle imports that it may not (allowedServerImport), each once, in the order
 * found. Read from the source text, not parsed: a bundle is one minified file, and an import a
 * string happens to spell out is refused too, which the message names.
 */
export function unbundledImports(source: string, helperModule: string): string[] {
  const found = new Set<string>()
  for (const re of IMPORT_RES) {
    for (const m of source.matchAll(re)) {
      const spec = m[1] as string
      if (!allowedServerImport(spec, helperModule)) found.add(spec)
    }
  }
  return [...found]
}

/**
 * Fling's helpers for a site server, `import { viewer, file, secret } from '<CLI package>/server'`.
 * Each platform has its own small implementation, which the CLI's bundler puts in place of the
 * import (and a runtime resolves for a bundle that kept it): the same API everywhere.
 */
export interface FlingServerHelpers {
  /**
   * Who is calling (VIEWER_HEADER), from a fetch Request or a Node IncomingMessage; null on a
   * public site, a share link, or with no one signed in.
   */
  viewer(
    request: Request | { headers: Record<string, string | string[] | undefined> }
  ): SiteViewer | null
  /**
   * One of this version's published files, as a Response (404 for a file it doesn't have, a
   * dotfile, anything under `_fling/` or outside the version).
   */
  file(path: string): Promise<Response>
  /** A site secret (`process.env.NAME`); throws, naming it, when it isn't set. */
  secret(name: string): string
}

/** The viewer header's value from a fetch Request or a Node IncomingMessage. */
export function viewerHeaderOf(
  request: Request | { headers: Record<string, string | string[] | undefined> }
): string | null {
  const headers = request.headers as unknown
  if (headers && typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(VIEWER_HEADER)
  }
  const raw = (headers as Record<string, string | string[] | undefined>)[VIEWER_HEADER]
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null)
}

/**
 * A path `file()` may read: relative to the version, no dot segment (dotfiles, `..`), nothing
 * under `_fling/`. Returns it without a leading slash, or null.
 */
export function serverFilePath(path: string): string | null {
  const p = path.replace(/^\/+/, '')
  if (!p || p.split('/').some(s => s === '' || s.startsWith('.'))) return null
  if (p.startsWith('_fling/')) return null
  return p
}
