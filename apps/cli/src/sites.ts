/**
 * The site operations, as plain functions over an `ApiClient` that return data. The CLI commands
 * print what these return; the MCP tools serialise it. Nothing here prints.
 */
import {
  type Me,
  MeSchema,
  type NameCheck,
  NameCheckSchema,
  type Site,
  type SiteDetail,
  SiteDetailSchema,
  SiteListSchema,
  SiteSchema,
  siteUrl,
  type VersionFiles,
  VersionFilesSchema,
  type Visibility,
} from '@fling/shared'
import { z } from 'zod'
import type { ApiClient } from './api.ts'
import { CliError } from './errors.ts'

/**
 * Response of `POST /api/sites/:name/share`. Not (yet) in `@fling/shared/api.ts`, so it lives here;
 * tolerant of the server returning the whole site alongside.
 */
export const ShareResponseSchema = z.looseObject({ shareUrl: z.string() })

const sitePath = (name: string) => `/api/sites/${encodeURIComponent(name)}`

export function whoami(client: ApiClient): Promise<Me> {
  return client.request('GET', '/api/me', { schema: MeSchema })
}

/** GET /api/names/:name — available, yours, taken (with free suggestions) or invalid. */
export function checkName(client: ApiClient, name: string): Promise<NameCheck> {
  return client.request('GET', `/api/names/${encodeURIComponent(name)}`, {
    schema: NameCheckSchema,
  })
}

/** Where sites are served: `https:` + `fling.labs.nearform.com` (a site is `<name>.<domain>`). */
export interface SitesBase {
  protocol: string
  /** host, including any port */
  domain: string
}

/**
 * Inferred from the server URL: the API lives at `https://fling.labs.nearform.com` and sites at
 * `https://<name>.fling.labs.nearform.com`. Null when that can't be relied on — a server with an
 * explicit port (local dev serves sites on another port), an IP or a dotless host.
 */
export function sitesBaseFor(serverUrl: string): SitesBase | null {
  try {
    const url = new URL(serverUrl)
    const { hostname } = url
    if (
      url.port ||
      !hostname.includes('.') ||
      /^[\d.]+$/.test(hostname) ||
      hostname.startsWith('[')
    )
      return null
    return { protocol: url.protocol, domain: hostname }
  } catch {
    return null
  }
}

/** From an existing site URL: `http://docs.fling.lvh.me:4102/` → `http:` + `fling.lvh.me:4102`. */
export function sitesBaseFromSiteUrl(siteUrl: string): SitesBase | null {
  try {
    const url = new URL(siteUrl)
    const dot = url.host.indexOf('.')
    return dot > 0 ? { protocol: url.protocol, domain: url.host.slice(dot + 1) } : null
  } catch {
    return null
  }
}

/**
 * The sites base for display: inferred from the server URL, else read off one of the user's sites
 * (the API has no endpoint for it). Null when neither works; never throws.
 */
export async function discoverSitesBase(client: ApiClient): Promise<SitesBase | null> {
  const inferred = sitesBaseFor(client.serverUrl)
  if (inferred) return inferred
  const sites = await listSites(client).catch(() => [])
  const first = sites[0]
  return first ? sitesBaseFromSiteUrl(first.url) : null
}

export function siteUrlFor(name: string, base: SitesBase): string {
  return siteUrl(name, base.domain, base.protocol)
}

/** `https://<name>.fling.labs.nearform.com/` for display. */
export function sitesPattern(base: SitesBase | null): string {
  return base ? siteUrlFor('<name>', base) : '<name>.<sites domain>'
}

export async function listSites(
  client: ApiClient,
  opts: { archived?: boolean } = {}
): Promise<Site[]> {
  const res = await client.request('GET', '/api/sites', {
    schema: SiteListSchema,
    query: { archived: opts.archived ? 1 : undefined },
  })
  return res.sites
}

export function getSite(client: ApiClient, name: string): Promise<SiteDetail> {
  return client.request('GET', sitePath(name), { schema: SiteDetailSchema })
}

export interface SiteFiles extends VersionFiles {
  name: string
  url: string
  /** the version being served */
  current: boolean
}

/** The files in `versionId`, or in the version being served when omitted. */
export async function versionFiles(
  client: ApiClient,
  name: string,
  versionId?: string
): Promise<SiteFiles> {
  const site = await getSite(client, name)
  const id = versionId ?? site.currentVersionId
  if (!id) throw new CliError(`${name} has no published version yet`)
  const files = await client.request(
    'GET',
    `${sitePath(name)}/versions/${encodeURIComponent(id)}/files`,
    { schema: VersionFilesSchema }
  )
  return { name: site.name, url: site.url, current: id === site.currentVersionId, ...files }
}

/**
 * Mutations whose response body the contract does not pin down: use it when it is a site, else
 * read the site back.
 */
async function siteAfter(client: ApiClient, name: string, raw: unknown): Promise<Site> {
  const parsed = SiteSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const nested = SiteSchema.safeParse((raw as { site?: unknown } | undefined)?.site)
  if (nested.success) return nested.data
  return getSite(client, name)
}

export async function rollback(client: ApiClient, name: string, versionId: string): Promise<Site> {
  const raw = await client.request('POST', `${sitePath(name)}/current`, { body: { versionId } })
  return siteAfter(client, name, raw)
}

export async function setVisibility(
  client: ApiClient,
  name: string,
  visibility: Visibility
): Promise<Site> {
  const raw = await client.request('PATCH', sitePath(name), { body: { visibility } })
  return siteAfter(client, name, raw)
}

export async function archiveSite(
  client: ApiClient,
  name: string,
  opts: { unarchive?: boolean } = {}
): Promise<Site> {
  const raw = await client.request(
    'POST',
    `${sitePath(name)}/${opts.unarchive ? 'unarchive' : 'archive'}`
  )
  return siteAfter(client, name, raw)
}

export async function deleteSite(
  client: ApiClient,
  name: string
): Promise<{ name: string; deleted: true }> {
  await client.request('DELETE', sitePath(name))
  return { name, deleted: true }
}

export type ShareResult =
  | { name: string; action: 'existing' | 'created' | 'refreshed'; shareUrl: string }
  | { name: string; action: 'revoked'; shareUrl: null }

/**
 * Share link management. Without flags: return the current link, or create one. `refresh` rotates
 * (the old link stops working); `revoke` removes it.
 */
export async function share(
  client: ApiClient,
  name: string,
  opts: { refresh?: boolean; revoke?: boolean } = {}
): Promise<ShareResult> {
  if (opts.revoke) {
    await client.request('DELETE', `${sitePath(name)}/share`)
    return { name, action: 'revoked', shareUrl: null }
  }
  let hadLink = false
  if (!opts.refresh) {
    const site = await getSite(client, name)
    if (site.shareUrl) return { name, action: 'existing', shareUrl: site.shareUrl }
  } else hadLink = true
  const res = await client.request('POST', `${sitePath(name)}/share`, {
    schema: ShareResponseSchema,
  })
  return { name, action: hadLink ? 'refreshed' : 'created', shareUrl: res.shareUrl }
}
