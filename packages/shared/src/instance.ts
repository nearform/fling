// Instance metadata: what a Fling deployment says about itself at `GET /.well-known/fling` on its
// app origin. Published artifacts (the CLI, the MCP servers, the web build) carry no instance
// values; they read these instead. Browser-safe (zod only).
//
// Versioned for evolution: `version` only goes up for a change old clients cannot read, every
// object is loose (unknown fields are kept, never rejected), and new fields are optional. A client
// accepts any document that has the fields it needs.

import { z } from 'zod'
import {
  type DefaultAccessLevel,
  DefaultAccessLevelSchema,
  LEGACY_DEFAULT_ACCESS,
} from './access.ts'

export const INSTANCE_METADATA_PATH = '/.well-known/fling'
export const INSTANCE_METADATA_VERSION = 1
/** `Cache-Control` max-age of the metadata, in seconds. */
export const INSTANCE_METADATA_MAX_AGE = 300

/** `#rgb` or `#rrggbb`: the only colour syntax brand config accepts (it ends up in CSS). */
export const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

const color = z.string().regex(HEX_COLOR_RE)

/**
 * How people sign in. `kind` names the method: `oidc` (the instance's OpenID Connect `issuer`) or
 * `dev` (local dev login); clients show `displayName` ("Sign in with …") and must tolerate kinds
 * they don't know. A verified email gets in if its domain is in `emailDomains`, or if it is one of
 * the instance's invited addresses (`invitedEmails`: there are some; the addresses themselves are
 * never published).
 */
export const InstanceAuthSchema = z.looseObject({
  kind: z.string().min(1),
  displayName: z.string().min(1),
  issuer: z.string().optional(),
  emailDomains: z.array(z.string()).default([]),
  invitedEmails: z.boolean().optional(),
})
export type InstanceAuth = z.infer<typeof InstanceAuthSchema>

/**
 * The colours a deployment may set; the web derives every shade from these. `primary` backs
 * primary buttons and active states (with `primaryContent` on it), `accent` is links and focus,
 * `ink` is text and the dark chrome, `highlight` a decorative third colour.
 */
export const BrandColorsSchema = z.looseObject({
  primary: color.optional(),
  primaryContent: color.optional(),
  accent: color.optional(),
  ink: color.optional(),
  highlight: color.optional(),
})
export type BrandColors = z.infer<typeof BrandColorsSchema>

/** Looks. Every field is optional: without them the web's neutral default theme applies. */
export const InstanceBrandSchema = z.looseObject({
  /** https: or data: URL of the logo mark shown before the name (light theme). */
  logoUrl: z.string().optional(),
  /** The same for the dark theme; defaults to `logoUrl`. */
  logoDarkUrl: z.string().optional(),
  faviconUrl: z.string().optional(),
  colors: BrandColorsSchema.default({}),
})
export type InstanceBrand = z.infer<typeof InstanceBrandSchema>

export const InstanceMetadataSchema = z.looseObject({
  version: z.number().int().min(1),
  /** Display name, e.g. "Fling". */
  name: z.string().min(1),
  /** e.g. `https://fling.example.test` (no trailing slash) */
  appOrigin: z.string().url(),
  /** host[:port] sites hang off: a site is `<name>.<sitesDomain>` */
  sitesDomain: z.string().min(1),
  siteScheme: z.enum(['http', 'https']),
  auth: InstanceAuthSchema,
  brand: InstanceBrandSchema.default({ colors: {} }),
  /** Feature flags: a client hides what is missing or false. */
  capabilities: z.record(z.string(), z.boolean()).default({}),
  /** How to install the CLI, e.g. `npm install -g <package>`. */
  installCommand: z.string().min(1),
  /**
   * The access level a new site gets when its first deploy names none (`SITE_DEFAULT_ACCESS`).
   * Missing (older servers) or unknown: `members` (`defaultAccessOf`).
   */
  defaultAccess: DefaultAccessLevelSchema.optional().catch(undefined),
})
export type InstanceMetadata = z.infer<typeof InstanceMetadataSchema>

/**
 * What every instance has. Features an instance can turn off are added by its config (`comments`,
 * COMMENTS; `live`; `notifications`, the hub and its settings, on when at least one channel is;
 * `email`, the email channel, on with a mail driver; `invites`, invitations from outside the email
 * policy and the emailed sign-in links they use, INVITES); missing means unsupported.
 */
export const CORE_CAPABILITIES = {
  /** the remote MCP connector at `/mcp` */
  remoteMcp: true,
  shareLinks: true,
  publicSites: true,
  archive: true,
  rollback: true,
  /** a private site can be limited to listed people (its audience) */
  audiences: true,
  /** named lists of people (groups.ts) that any member can use in an audience */
  groups: true,
  /** the five access levels (access.ts), `only_me` among them, set with `access` */
  accessLevels: true,
  /** a site's owners and publishers, people and groups (site-roles.ts), set with `owners`/`publishers` */
  siteRoles: true,
  /** a deploy can replace one folder of a site and keep the rest (`DeployRequest.path`) */
  pathPublish: true,
  /**
   * a live preview of each site's home page on its site page, and a thumbnail of it in the site
   * lists, taken by its owners' and publishers' browsers (thumbnails.ts)
   */
  thumbnails: true,
} as const

/** The access level the instance gives a new site when its first deploy names none. */
export const defaultAccessOf = (
  instance: Partial<Pick<InstanceMetadata, 'defaultAccess'>> | null | undefined
): DefaultAccessLevel => instance?.defaultAccess ?? LEGACY_DEFAULT_ACCESS

/** `https://<name>.sites.example.test/` — a site's URL on an instance. */
export function instanceSiteUrl(
  instance: Pick<InstanceMetadata, 'sitesDomain' | 'siteScheme'>,
  label: string
): string {
  return `${instance.siteScheme}://${label}.${instance.sitesDomain}/`
}

/** `https://<name>.sites.example.test`, for copy. */
export function instanceSitesPattern(
  instance: Pick<InstanceMetadata, 'sitesDomain' | 'siteScheme'>
) {
  return `${instance.siteScheme}://<name>.${instance.sitesDomain}`
}

/** `@example.test` / `@a.test or @b.test`, or null when any verified email may sign in. */
export function emailDomainsPhrase(auth: Pick<InstanceAuth, 'emailDomains'>): string | null {
  const domains = auth.emailDomains.map(d => `@${d}`)
  if (domains.length === 0) return null
  return domains.length === 1
    ? (domains[0] as string)
    : `${domains.slice(0, -1).join(', ')} or ${domains.at(-1)}`
}

/**
 * The accounts that may sign in, for copy: `@example.test accounts`, `invited accounts`,
 * `@example.test accounts and invited accounts`, or null when any verified email may sign in.
 */
export function allowedAccountsPhrase(
  auth: Pick<InstanceAuth, 'emailDomains' | 'invitedEmails'>
): string | null {
  const domains = emailDomainsPhrase(auth)
  const parts = [domains && `${domains} accounts`, auth.invitedEmails && 'invited accounts']
  return parts.filter(Boolean).join(' and ') || null
}

/**
 * Who may open a private site, for copy: "anyone signed in to Fling (@example.test accounts)".
 */
export function privateAudience(instance: Pick<InstanceMetadata, 'name' | 'auth'>): string {
  const accounts = allowedAccountsPhrase(instance.auth)
  return `anyone signed in to ${instance.name}${accounts ? ` (${accounts})` : ''}`
}

/** The metadata URL of the instance at `serverUrl`. */
export function instanceMetadataUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '')}${INSTANCE_METADATA_PATH}`
}
