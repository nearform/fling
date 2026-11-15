/**
 * The request log and reading a site's server log. Every invoke gets one line from Fling
 * (`logInvoke`, called by the shell that ran it: method, path, status, duration, the viewer's id,
 * the version), beside what the server printed. A viewer's id, never their email: a site's logs
 * are read by everyone who publishes it (`site.logs`), and an admin resolves an id to an address
 * only when there is a reason (`resolveViewer`, audited as `viewer.resolved`).
 */

import { createHmac } from 'node:crypto'
import { SERVER_LOG_DAYS, type ServerLogLine } from '@fling/shared'
import { viewerIdOf } from '@fling/shared/site-routing'
import { audit } from '../audit.ts'
import { badRequest } from '../lib/errors.ts'
import type { SiteRecord } from '../store/types.ts'
import type { Deps } from '../types.ts'
import type { InvokeRecord, ServerLogs } from './types.ts'

/** The most lines one read returns. */
export const MAX_LOG_LINES = 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** The request line of one invoke. */
export function requestLine(at: Date, r: InvokeRecord): ServerLogLine {
  return {
    at: at.toISOString(),
    versionId: r.versionId,
    kind: 'request',
    method: r.method,
    path: r.path,
    status: r.status,
    ms: Math.round(r.ms),
    viewer: r.viewer?.id ?? null,
  }
}

/** Write an invoke's request line, where the platform's logs take lines from Fling. */
export async function logInvoke(logs: ServerLogs | undefined, at: Date, r: InvokeRecord) {
  if (!logs?.append) return
  await logs.append(r.siteId, [requestLine(at, r)])
}

/**
 * `since` as the API takes it: an ISO time, or a duration back from now (`90s`, `15m`, `1h`,
 * `2d`); default one hour. Never further back than the logs are kept.
 */
export function sinceOf(now: Date, raw: string | undefined): Date {
  const oldest = new Date(now.getTime() - SERVER_LOG_DAYS * DAY_MS)
  let since = new Date(now.getTime() - 60 * 60 * 1000)
  if (raw) {
    const m = /^(\d+)(s|m|h|d)$/.exec(raw)
    if (m) {
      const unit = { s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS }[m[2] as 's' | 'm' | 'h' | 'd']
      since = new Date(now.getTime() - Number(m[1]) * unit)
    } else {
      const t = Date.parse(raw)
      if (Number.isNaN(t))
        throw badRequest('`since` is an ISO time or a duration such as 15m, 1h or 2d')
      since = new Date(t)
    }
  }
  return since < oldest ? oldest : since
}

/** A site's server log since `since`, oldest first. */
export async function readLogs(
  deps: Deps,
  site: SiteRecord,
  since: Date,
  limit = MAX_LOG_LINES
): Promise<ServerLogLine[]> {
  if (!deps.serverLogs) return []
  return deps.serverLogs.read(site.id, since, Math.min(Math.max(limit, 1), MAX_LOG_LINES))
}

const hmac = (key: string, data: string) =>
  createHmac('sha256', key).update(data).digest('base64url')

/** A person's viewer id on a site, as the edge computes it (site-routing.ts `viewerIdOf`). */
export const viewerIdFor = (deps: Pick<Deps, 'config'>, siteId: string, email: string) =>
  viewerIdOf(deps.config.secrets.siteHmacKey, siteId, email, hmac)

/**
 * Whose viewer id `id` is on the site: each user of the instance hashed for that site until one
 * matches; null when none does. Audited (`viewer.resolved`) whatever it finds.
 */
export async function resolveViewer(
  deps: Deps,
  admin: string,
  site: SiteRecord,
  id: string
): Promise<string | null> {
  await audit(deps, { action: 'viewer.resolved', actor: admin, target: site.name, change: id })
  let cursor: string | undefined
  do {
    const page = await deps.store.listUsers({ limit: 500, cursor })
    for (const u of page.users) if (viewerIdFor(deps, site.id, u.email) === id) return u.email
    cursor = page.cursor
  } while (cursor)
  return null
}
