/**
 * Configuration: one zod schema over the env object (rocketpod pattern). Plain vars come from the
 * Lambda environment; secrets come from SSM (`SSM_PREFIX`, loaded once per cold start in
 * platforms/aws/src/secrets.ts) or, when that is unset (dev/tests), from the same-named env vars.
 * Sign-in (`OIDC_*` and the Google client) is resolved from both in auth/oidc.ts.
 */
import {
  DEFAULT_ACCESS_LEVELS,
  DEFAULT_INSTALL_COMMAND,
  type DefaultAccessLevel,
  HEX_COLOR_RE,
  type InstanceBrand,
  MAX_PATHS_PER_SITE,
  RESERVED_SITE_NAMES,
  type SettingGroup,
  type SettingValue,
} from '@fling/shared'
import { z } from 'zod'
import { emailAllowed } from './auth/identity.ts'

/** Blank env strings are "unset". */
const blank = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

const optionalString = z.preprocess(blank, z.string().min(1).optional())

const csvLower = z.preprocess(
  value =>
    typeof value === 'string'
      ? value
          .split(',')
          .map(s => s.trim().toLowerCase())
          .filter(Boolean)
      : value,
  z.array(z.string().min(1)).min(1)
)

/** A full email address, as ALLOWED_EMAILS lists them. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/

/** A comma-separated list of email addresses, lowercased (ALLOWED_EMAILS, ADMIN_EMAILS). */
const emailList = z.preprocess(
  blank,
  csvLower.pipe(z.array(z.string().regex(EMAIL_RE, 'must be an email address'))).optional()
)

/** One email address (MAIL_FROM, MAIL_REPLY_TO), lowercased. */
const emailAddress = z.preprocess(
  value => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.preprocess(blank, z.string().regex(EMAIL_RE, 'must be an email address').optional())
)

/** Text that goes into a mail header (MAIL_FROM_NAME): one line. */
const headerText = z.preprocess(
  blank,
  z
    .string()
    .min(1)
    .max(100)
    .refine(v => !/[\r\n]/.test(v), 'must be one line')
    .optional()
)

const hexColor = z.preprocess(blank, z.string().regex(HEX_COLOR_RE).optional())

/** A logo/favicon: https: (or http: for local dev), or an inline data: image. */
const assetUrl = z.preprocess(
  blank,
  z
    .string()
    .refine(v => /^(https?:\/\/|data:image\/)/.test(v), 'must be an http(s) or data:image URL')
    .optional()
)

const flag = z.preprocess(
  value => typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  z.boolean()
)

/** A switch that is on unless set to 0/false/no/off. */
const flagDefaultOn = z.preprocess(
  value =>
    !(
      typeof value === 'string' && ['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())
    ),
  z.boolean()
)

/** A number of days, 0 to 3650 (ten years); `fallback` when blank. */
const days = (fallback: number) =>
  z.preprocess(blank, z.coerce.number().int().min(0).max(3650).default(fallback))

const envSchema = z.object({
  APP_ENV: z.preprocess(blank, z.enum(['production', 'development']).default('development')),
  APP_ORIGIN: z.preprocess(blank, z.url().default('http://localhost:47101')),
  SITES_DOMAIN: z.preprocess(blank, z.string().min(1).default('localhost:47102')),
  SITE_SCHEME: z.preprocess(blank, z.enum(['http', 'https']).optional()),
  SITE_COOKIE_DOMAIN: z.preprocess(blank, z.string().min(1).default('localhost')),
  /**
   * Who may sign in: whole domains and/or individual addresses. Production needs at least one;
   * with neither, dev/tests fall back to DEV_EMAIL_DOMAINS.
   */
  ALLOWED_EMAIL_DOMAINS: z.preprocess(blank, csvLower.optional()),
  ALLOWED_EMAILS: emailList,
  /** The instance's admins (users list, impersonation). They still have to be allowed to sign in. */
  ADMIN_EMAILS: emailList,
  INSTANCE_NAME: z.preprocess(blank, z.string().min(1).max(60).default('Fling')),
  INSTALL_COMMAND: z.preprocess(blank, z.string().min(1).default(DEFAULT_INSTALL_COMMAND)),
  BRAND_LOGO_URL: assetUrl,
  BRAND_LOGO_DARK_URL: assetUrl,
  BRAND_FAVICON_URL: assetUrl,
  BRAND_PRIMARY: hexColor,
  BRAND_PRIMARY_CONTENT: hexColor,
  BRAND_ACCENT: hexColor,
  BRAND_INK: hexColor,
  BRAND_HIGHLIGHT: hexColor,
  TABLE_NAME: optionalString,
  SITES_BUCKET: optionalString,
  KVS_ARN: optionalString,
  SSM_PREFIX: optionalString,
  STORE_DRIVER: z.preprocess(
    blank,
    z.enum(['dynamo', 'd1', 'postgres', 'firestore', 'cosmos', 'memory']).optional()
  ),
  STORAGE_DRIVER: z.preprocess(blank, z.enum(['s3', 'r2', 'gcs', 'azure-blob', 'fs']).optional()),
  KVS_DRIVER: z.preprocess(
    blank,
    z.enum(['cloudfront', 'workers-kv', 'table', 'memory']).optional()
  ),
  /** The Postgres schema the Node host's Table is in (platforms/node; default `public`). */
  DATABASE_SCHEMA: z.preprocess(
    blank,
    z
      .string()
      .regex(/^[a-z_][a-z0-9_]{0,62}$/, 'lower-case letters, digits and _')
      .optional()
  ),
  FS_ROOT: optionalString,
  DEV_LOGIN: flag,
  OAUTH_REDIRECT_ALLOWLIST: z.preprocess(blank, z.string().optional()),
  /**
   * Another OAuth authorization server whose access tokens `/mcp` accepts and that the
   * protected-resource metadata names (instead of this instance's own). Unset: only this
   * instance's own server.
   */
  MCP_AUTHORIZATION_SERVER: z.preprocess(blank, z.url().optional()),
  OIDC_ISSUER: z.preprocess(blank, z.url().optional()),
  OIDC_CLIENT_ID: optionalString,
  OIDC_DISPLAY_NAME: z.preprocess(blank, z.string().min(1).max(60).optional()),
  OIDC_SCOPES: optionalString,
  OIDC_ASSUME_EMAIL_VERIFIED: flag,
  SITE_DEFAULT_ACCESS: z.preprocess(blank, z.enum(DEFAULT_ACCESS_LEVELS).default('only_me')),
  /** The most live Paths one site may have (each is a route key), at most MAX_PATHS_PER_SITE. */
  PATHS_PER_SITE_MAX: z.preprocess(
    blank,
    z.coerce.number().int().min(1).max(MAX_PATHS_PER_SITE).default(MAX_PATHS_PER_SITE)
  ),
  COMMENTS: flagDefaultOn,
  LIVE: flagDefaultOn,
  LIVE_URL: z.preprocess(
    blank,
    z
      .url()
      .refine(v => /^wss?:\/\//.test(v), 'must be a ws:// or wss:// URL')
      .optional()
  ),
  MAIL_DRIVER: z.preprocess(
    blank,
    z.enum(['ses', 'cloudflare', 'smtp', 'acs', 'file', 'memory']).optional()
  ),
  MAIL_FROM: emailAddress,
  MAIL_FROM_NAME: headerText,
  MAIL_REPLY_TO: emailAddress,
  SES_CONFIGURATION_SET: optionalString,
  SMTP_HOST: optionalString,
  SMTP_PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65535).optional()),
  SMTP_SECURITY: z.preprocess(blank, z.enum(['tls', 'starttls', 'none']).optional()),
  SMTP_USER: optionalString,
  /** Outside invitations: off unless `on` (or true/yes/1); on needs mail. */
  INVITES: flag,
  /** Sites' view counts (views.ts): on unless `off` (or false/no/0). */
  SITE_VIEW_COUNTS: flagDefaultOn,
  /** Deleting a site (deletion.ts): `soft` (the default) keeps its files for an admin to restore. */
  SITE_DELETE: z.preprocess(
    value => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.preprocess(blank, z.enum(['soft', 'hard']).default('soft'))
  ),
  INVITES_PER_DAY: z.preprocess(blank, z.coerce.number().int().positive().default(20)),
  VERSION_RETENTION: z.preprocess(blank, z.coerce.number().int().min(0).max(10_000).default(0)),
  /** The archive policy (archive-policy.ts), in days: 0 is off, and off unless set. */
  ARCHIVE_INACTIVE_DAYS: days(0),
  ARCHIVE_WARN_DAYS: days(7),
  DELETE_ARCHIVED_DAYS: days(0),
  PURGE_DELETED_DAYS: days(0),
  /** Maintenance's sweep of every site, behind its queue: on unless `off` (or false/no/0). */
  MAINTENANCE_SWEEP_ENABLED: flagDefaultOn,
  /** Who may publish a site server: `off`, `admins`, `members` or `groups:<slug>,<slug>`. */
  SERVERS: z.preprocess(
    value => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.preprocess(
      blank,
      z
        .string()
        .regex(
          /^(off|admins|members|groups:[a-z0-9-]+(,[a-z0-9-]+)*)$/,
          'must be off, admins, members or groups:<slug>,<slug>'
        )
        .default('off')
    )
  ),
  SERVERS_EGRESS: z.preprocess(blank, z.enum(['none', 'open']).default('none')),
  SERVERS_MAX_SITES: z.preprocess(blank, z.coerce.number().int().min(0).default(50)),
  SERVER_TIMEOUT_SECONDS: z.preprocess(blank, z.coerce.number().int().min(1).max(900).default(30)),
  SERVER_CPU_MS: z.preprocess(blank, z.coerce.number().int().min(10).max(300_000).default(1000)),
  SERVER_RPS: z.preprocess(blank, z.coerce.number().int().min(1).max(100_000).default(100)),
  SERVER_ENVIRONMENTS: z.preprocess(blank, z.coerce.number().int().min(1).max(10_000).default(2)),
  SERVER_BODY_BYTES: z.preprocess(
    blank,
    z.coerce
      .number()
      .int()
      .min(1024)
      .max(100 * 1024 * 1024)
      .default(10 * 1024 * 1024)
  ),
})

export type EnvKey = keyof typeof envSchema.shape

/** Every key the instance reads from its environment (the env schema's), in schema order. */
export const ENV_KEYS = Object.keys(envSchema.shape) as EnvKey[]

/**
 * Where each env key sits on the admins' Settings tab. A Record over the schema's keys, so a new
 * key without a group fails to typecheck (and tests/settings.test.ts).
 */
export const SETTING_GROUP: Record<EnvKey, SettingGroup> = {
  ALLOWED_EMAIL_DOMAINS: 'sign_in',
  ALLOWED_EMAILS: 'sign_in',
  ADMIN_EMAILS: 'sign_in',
  OIDC_ISSUER: 'sign_in',
  OIDC_CLIENT_ID: 'sign_in',
  OIDC_DISPLAY_NAME: 'sign_in',
  OIDC_SCOPES: 'sign_in',
  OIDC_ASSUME_EMAIL_VERIFIED: 'sign_in',
  OAUTH_REDIRECT_ALLOWLIST: 'sign_in',
  MCP_AUTHORIZATION_SERVER: 'sign_in',
  DEV_LOGIN: 'sign_in',
  APP_ORIGIN: 'sites',
  SITES_DOMAIN: 'sites',
  SITE_SCHEME: 'sites',
  SITE_COOKIE_DOMAIN: 'sites',
  SITE_DEFAULT_ACCESS: 'sites',
  PATHS_PER_SITE_MAX: 'sites',
  INSTANCE_NAME: 'branding',
  INSTALL_COMMAND: 'branding',
  BRAND_LOGO_URL: 'branding',
  BRAND_LOGO_DARK_URL: 'branding',
  BRAND_FAVICON_URL: 'branding',
  BRAND_PRIMARY: 'branding',
  BRAND_PRIMARY_CONTENT: 'branding',
  BRAND_ACCENT: 'branding',
  BRAND_INK: 'branding',
  BRAND_HIGHLIGHT: 'branding',
  COMMENTS: 'features',
  LIVE: 'features',
  LIVE_URL: 'features',
  INVITES: 'features',
  INVITES_PER_DAY: 'features',
  SITE_VIEW_COUNTS: 'features',
  SITE_DELETE: 'features',
  VERSION_RETENTION: 'features',
  ARCHIVE_INACTIVE_DAYS: 'features',
  ARCHIVE_WARN_DAYS: 'features',
  DELETE_ARCHIVED_DAYS: 'features',
  PURGE_DELETED_DAYS: 'features',
  MAINTENANCE_SWEEP_ENABLED: 'features',
  SERVERS: 'features',
  SERVERS_EGRESS: 'features',
  SERVERS_MAX_SITES: 'features',
  SERVER_TIMEOUT_SECONDS: 'features',
  SERVER_CPU_MS: 'features',
  SERVER_RPS: 'features',
  SERVER_ENVIRONMENTS: 'features',
  SERVER_BODY_BYTES: 'features',
  MAIL_DRIVER: 'mail',
  MAIL_FROM: 'mail',
  MAIL_FROM_NAME: 'mail',
  MAIL_REPLY_TO: 'mail',
  SES_CONFIGURATION_SET: 'mail',
  SMTP_HOST: 'mail',
  SMTP_PORT: 'mail',
  SMTP_SECURITY: 'mail',
  SMTP_USER: 'mail',
  APP_ENV: 'platform',
  TABLE_NAME: 'platform',
  SITES_BUCKET: 'platform',
  KVS_ARN: 'platform',
  SSM_PREFIX: 'platform',
  STORE_DRIVER: 'platform',
  DATABASE_SCHEMA: 'platform',
  STORAGE_DRIVER: 'platform',
  KVS_DRIVER: 'platform',
  FS_ROOT: 'platform',
}

/** One env key as the admins' Settings tab shows it. */
export interface ConfigSetting {
  key: EnvKey
  group: SettingGroup
  /** what the instance runs with: the env's value parsed, or the default it falls back to */
  value: SettingValue
  /** the environment set it (not blank) */
  set: boolean
}

/**
 * OAuth redirect URIs any client (DCR or CIMD) may use. Exact URLs; a prefix ending in `*`, for a
 * last path segment that names the user (oauth/clients.ts `prefixAllows`); and the keyword
 * `loopback` for `http://localhost|127.0.0.1|[::1]:<any port>/<any path>`.
 */
export const DEFAULT_OAUTH_REDIRECT_ALLOWLIST = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  // ChatGPT's connectors: its stable redirect, used with authorization servers that return `iss`
  // (RFC 9207), as this one does.
  'https://chatgpt.com/connector_platform_oauth_redirect',
  // Cursor's web app and background agents (its desktop app and CLI use loopback).
  'https://www.cursor.com/agents/mcp/oauth/callback',
  // The Gemini app's custom connectors register a redirect per user and server on each of Google's
  // OAuth relays (production, sandbox, test), under both /r/ and /a/, and all six must pass.
  ...['oauth-redirect', 'oauth-redirect-sandbox', 'oauth-redirect-test'].flatMap(host =>
    ['r', 'a'].map(path => `https://${host}.googleusercontent.com/${path}/*`)
  ),
  // Desktop and command-line clients on this computer: Claude Code, Cursor, Gemini CLI, Codex,
  // VS Code, MCP Inspector.
  'loopback',
]

/** Who may sign in to a dev/test instance when no ALLOWED_EMAIL_DOMAINS/ALLOWED_EMAILS is set. */
export const DEV_EMAIL_DOMAINS = ['example.test']

/**
 * The admin of an instance with dev login on and no ADMIN_EMAILS (local dev, the e2e). Dev login
 * already lets anyone be anyone, so this grants nothing that isn't there; production never has it.
 */
export const DEV_ADMIN_EMAILS = ['admin@example.test']

export interface Secrets {
  /** The OIDC_ISSUER client's secret (`OIDC_CLIENT_SECRET`; SSM `oidc-client-secret`). */
  oidcClientSecret?: string
  /**
   * A Google OAuth client (`GOOGLE_CLIENT_ID/SECRET`; SSM `google-client-id/secret`): the `google`
   * sign-in provider, the issuer https://accounts.google.com on `/auth/google/callback`, offered
   * beside OIDC_ISSUER's when both are set.
   */
  googleClientId?: string
  googleClientSecret?: string
  sessionSecret: string
  siteHmacKey: string
  /**
   * Seals site secrets (`SITE_SECRETS_KEY`: 32 random bytes, hex or base64; servers/secrets.ts).
   * Required when SERVERS is on (buildDeps); nothing else is derived from it.
   */
  siteSecretsKey?: string
  /** CloudFront adds `x-origin-verify: <secret>`; unset → no check. */
  originVerifySecret?: string
  /** The SMTP server's password for SMTP_USER (`SMTP_PASSWORD`; the `smtp` mail driver). */
  smtpPassword?: string
  /**
   * The Node host's Postgres (`DATABASE_URL`, `postgres://…`, which can carry a password; the
   * `postgres` store driver). Unset there: Postgres in process (PGlite), for local runs.
   */
  databaseUrl?: string
  /**
   * What a caller of the Node host's tick and migrate endpoints presents (`TICK_SECRET`, at least
   * 32 characters, as `Authorization: Bearer <secret>`). Unset: the endpoints answer 404.
   */
  tickSecret?: string
  /**
   * The instance's Slack app (`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`; slack/): with both set,
   * links posted in its workspace get a rich preview (`slackUnfurls`). The signing secret proves an
   * event came from Slack; the bot token answers it.
   */
  slackSigningSecret?: string
  slackBotToken?: string
}

/**
 * Each secret by the env name it is read from (SSM: the same in kebab case), and where the
 * admins' Settings tab lists it. The tab shows only whether one is set, never its value.
 */
export const SECRET_SETTINGS: Record<keyof Secrets, { name: string; group: SettingGroup }> = {
  oidcClientSecret: { name: 'OIDC_CLIENT_SECRET', group: 'sign_in' },
  googleClientId: { name: 'GOOGLE_CLIENT_ID', group: 'sign_in' },
  googleClientSecret: { name: 'GOOGLE_CLIENT_SECRET', group: 'sign_in' },
  sessionSecret: { name: 'SESSION_SECRET', group: 'platform' },
  siteHmacKey: { name: 'SITE_HMAC_KEY', group: 'platform' },
  siteSecretsKey: { name: 'SITE_SECRETS_KEY', group: 'features' },
  originVerifySecret: { name: 'ORIGIN_VERIFY_SECRET', group: 'platform' },
  smtpPassword: { name: 'SMTP_PASSWORD', group: 'mail' },
  databaseUrl: { name: 'DATABASE_URL', group: 'platform' },
  tickSecret: { name: 'TICK_SECRET', group: 'platform' },
  slackSigningSecret: { name: 'SLACK_SIGNING_SECRET', group: 'features' },
  slackBotToken: { name: 'SLACK_BOT_TOKEN', group: 'features' },
}

/** The secrets by name, set or not: no value leaves here. */
export function secretSettings(
  secrets: Secrets
): { name: string; group: SettingGroup; set: boolean }[] {
  return (Object.keys(SECRET_SETTINGS) as (keyof Secrets)[]).map(k => ({
    ...SECRET_SETTINGS[k],
    set: Boolean(secrets[k]),
  }))
}

/** The `oidc` sign-in provider from env (`OIDC_*`); the client secret is in Secrets. */
export interface OidcConfig {
  /** Exactly the issuer's `iss` (e.g. https://accounts.google.com); unset → no `oidc` provider. */
  issuer?: string
  clientId?: string
  /** What its sign-in button says ("Sign in with …"); default derived from the issuer. */
  displayName?: string
  /** Default `openid email profile`. */
  scopes?: string[]
  /** Treat a missing `email_verified` claim as verified (an explicit `false` is still refused). */
  assumeEmailVerified: boolean
}

/**
 * Email (`MAIL_*`, from the platform's infrastructure: the Terraform `mail` variable, the
 * Cloudflare deploy config's `MAIL`). Set only when `MAIL_DRIVER` is; without it there is no
 * email channel. The addresses are never published.
 */
export interface MailConfig {
  /**
   * Which Mailer sends: the core has `memory` (tests, the e2e's Node runtime) and `file` (local dev,
   * `.fling-dev/mail/`); a platform supplies `ses`, `cloudflare`, `smtp` (platforms/node, for any
   * provider or relay that takes SMTP) or `acs` (platforms/azure). Production takes only those.
   */
  driver: 'ses' | 'cloudflare' | 'smtp' | 'acs' | 'file' | 'memory'
  /** The sender address (`MAIL_FROM`), on a domain that is not the sites domain. */
  from: string
  /** The sender's display name (`MAIL_FROM_NAME`, default INSTANCE_NAME). */
  fromName: string
  /** The operator's reply-to address on every email (`MAIL_REPLY_TO`); never the actor's. */
  replyTo?: string
  /** AWS: the SES configuration set to name on each send; unset, the identity's default applies. */
  sesConfigurationSet?: string
  /** The `smtp` driver's server (`SMTP_*`; its password is the `SMTP_PASSWORD` secret). */
  smtp?: SmtpConfig
}

/**
 * An SMTP server (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`). `security` is `tls`
 * (TLS from the start, port 465), `starttls` (the default: the server must upgrade the
 * connection, port 587) or `none` (a local relay; refused in production).
 */
export interface SmtpConfig {
  host: string
  port: number
  security: 'tls' | 'starttls' | 'none'
  user?: string
}

/** Who may publish a site server (`SERVERS`): nobody, admins, every member, or members of groups. */
export type ServersPublish =
  | { kind: 'off' }
  | { kind: 'admins' }
  | { kind: 'members' }
  | { kind: 'groups'; slugs: string[] }

/**
 * What one site's server may use per request and in all (`SERVER_*`): each platform enforces what
 * it can (servers/types.ts). Admins may raise them for one site (`SiteRecord.server.limits`).
 */
export interface ServerLimits {
  /**
   * wall time per request, streams included (`SERVER_TIMEOUT_SECONDS`, default 30); a server runs
   * with at most what the platform serves (`SiteServers.maxTimeoutSeconds`, servers/index.ts `limitsOf`)
   */
  timeoutSeconds: number
  /** CPU per request, where the platform measures it: one platform does (`SERVER_CPU_MS`, default 1000) */
  cpuMs: number
  /** requests per second to one site (`SERVER_RPS`, default 100) */
  rps: number
  /** environments one site may run at once, where the platform has them: one platform does (`SERVER_ENVIRONMENTS`, default 2) */
  environments: number
  /** the largest request body (`SERVER_BODY_BYTES`, default 10 MB) */
  bodyBytes: number
}

/** Site servers (`SERVERS*`, `SERVER_*`). */
/** The archive policy's settings, in days (0: off). See `Config.archivePolicy`. */
export interface ArchivePolicyConfig {
  inactiveDays: number
  warnDays: number
  deleteArchivedDays: number
  purgeDeletedDays: number
}

/**
 * The archive policy's settings, checked against each other: a warning must come before what it
 * warns of, and only what the policy archived is deleted, so deleting needs archiving on.
 */
function archivePolicyConfig(e: {
  ARCHIVE_INACTIVE_DAYS: number
  ARCHIVE_WARN_DAYS: number
  DELETE_ARCHIVED_DAYS: number
  PURGE_DELETED_DAYS: number
}): ArchivePolicyConfig {
  const inactive = e.ARCHIVE_INACTIVE_DAYS
  const warn = e.ARCHIVE_WARN_DAYS
  const del = e.DELETE_ARCHIVED_DAYS
  if (inactive > 0 && warn < 1) {
    throw new Error(
      'ARCHIVE_WARN_DAYS must be at least 1 when ARCHIVE_INACTIVE_DAYS is on: owners are always told before their site is archived'
    )
  }
  if (inactive > 0 && warn >= inactive) {
    throw new Error(
      `ARCHIVE_WARN_DAYS (${warn}) must be less than ARCHIVE_INACTIVE_DAYS (${inactive}): the warning comes before the archive`
    )
  }
  if (del > 0 && inactive === 0) {
    throw new Error(
      'DELETE_ARCHIVED_DAYS needs ARCHIVE_INACTIVE_DAYS: only sites the archive policy archived are deleted'
    )
  }
  if (del > 0 && warn >= del) {
    throw new Error(
      `ARCHIVE_WARN_DAYS (${warn}) must be less than DELETE_ARCHIVED_DAYS (${del}): the warning comes before the delete`
    )
  }
  return {
    inactiveDays: inactive,
    warnDays: warn,
    deleteArchivedDays: del,
    purgeDeletedDays: e.PURGE_DELETED_DAYS,
  }
}

export interface ServersConfig {
  /** who may publish one (`SERVERS`, default off: the `servers` capability is off) */
  publish: ServersPublish
  /** what a server may reach (`SERVERS_EGRESS`): `none` (the default) or `open` */
  egress: 'none' | 'open'
  /** how many sites may have a server at once (`SERVERS_MAX_SITES`, default 50) */
  maxSites: number
  limits: ServerLimits
}

/** `SERVERS` as config holds it. */
export function parseServersPublish(value: string): ServersPublish {
  if (value === 'admins' || value === 'members' || value === 'off') return { kind: value }
  return { kind: 'groups', slugs: value.slice('groups:'.length).split(',') }
}

export interface Config {
  appEnv: 'production' | 'development'
  /** The instance's display name (`INSTANCE_NAME`, default "Fling"). */
  instanceName: string
  /** e.g. https://fling.example.test (no trailing slash) */
  appOrigin: string
  /** host[:port] the site labels hang off, e.g. sites.example.test or localhost:47102 */
  sitesDomain: string
  siteScheme: 'http' | 'https'
  siteCookieDomain: string
  allowedEmailDomains: string[]
  /** Individual addresses admitted whatever their domain (`ALLOWED_EMAILS`). Never published. */
  allowedEmails: string[]
  /**
   * The instance's admins (`ADMIN_EMAILS`): they list users and impersonate them (policy.ts,
   * admin.ts). Checked on every request, so removing an address takes effect at once. Every one
   * must be allowed to sign in; never published.
   */
  adminEmails: string[]
  /** Logo, favicon and colours the web applies (`BRAND_*`); empty → the neutral default. */
  brand: InstanceBrand
  /** How the instance tells people to install the CLI (`INSTALL_COMMAND`). */
  installCommand: string
  /**
   * Who can open a new site whose first deploy names no access level (`SITE_DEFAULT_ACCESS`):
   * `only_me` (the default) or `members`. Published as `defaultAccess`; existing sites keep theirs.
   */
  siteDefaultAccess: DefaultAccessLevel
  /**
   * The most live Paths (published, not archived) one site may have (`PATHS_PER_SITE_MAX`, default
   * and ceiling MAX_PATHS_PER_SITE). Each live Path is a key in the route table, which on some
   * platforms is small and shared by every site. Published as `limits.pathsPerSite`.
   */
  pathsPerSite: number
  tableName?: string
  sitesBucket?: string
  kvsArn?: string
  ssmPrefix?: string
  /**
   * Which adapter each port uses. The core has the dev/test ones (memory, fs); a platform entry
   * supplies the others (platforms/aws: dynamo, s3, cloudfront; platforms/cloudflare: d1, r2,
   * workers-kv; platforms/node: postgres, and `table`, the routes in the Table itself;
   * platforms/gcp: firestore, gcs and `table`; platforms/azure: cosmos, azure-blob and `table`).
   * Production defaults to the AWS ones.
   */
  storeDriver: 'dynamo' | 'd1' | 'postgres' | 'firestore' | 'cosmos' | 'memory'
  storageDriver: 's3' | 'r2' | 'gcs' | 'azure-blob' | 'fs'
  kvsDriver: 'cloudfront' | 'workers-kv' | 'table' | 'memory'
  /** The Postgres schema of the `postgres` store driver (`DATABASE_SCHEMA`, default `public`). */
  databaseSchema?: string
  fsRoot?: string
  /**
   * Comments and review mode (`COMMENTS`, default on; `false` turns them off). Advertised as the
   * `comments` capability; off, the comment routes and tools don't exist.
   */
  comments: boolean
  /**
   * Live rooms (review mode's realtime: who else is looking, their pointers, comment changes as
   * they happen). On when comments are, `LIVE` is not off and the platform gave `LIVE_URL`, the
   * WebSocket clients connect to (`wss://<app host>/api/live` on Cloudflare, the API Gateway stage
   * on AWS, the dev server's own locally). Advertised as the `live` capability.
   */
  live: boolean
  /** `LIVE_URL`: where clients open the live room's socket (`${liveUrl}?ticket=…`) */
  liveUrl?: string
  /** Email, when a mail driver is configured (`MAIL_*`); absent: no email channel. */
  mail?: MailConfig
  /**
   * Outside invitations (`INVITES`, default off): people outside the email policy may be invited.
   * On needs `mail` (the config refuses to load otherwise).
   */
  invites: boolean
  /**
   * Whether the instance may count sites' views (`SITE_VIEW_COUNTS`, default on). On, an admin
   * turns view counting on or off for every site (Admin → Usage, views.ts): on, live versions'
   * pages are served from copies with the view beacon and the views it reports are counted. Off,
   * the operator's hard off: no new copies are made, route writes stop serving the ones there are,
   * nothing is counted, and the admins' switch is gone. Pushes are counted either way. Advertised
   * as the `viewCounts` capability.
   */
  viewCounts: boolean
  /**
   * What deleting a site or a Path does (`SITE_DELETE`, default `soft`; deletion.ts): `soft` takes
   * it down and frees its name but keeps its files, with a recovery file and a deleted-site record,
   * so an admin can restore it; `hard` deletes its files too. Advertised as the
   * `recoverableDeletes` capability.
   */
  siteDelete: 'soft' | 'hard'
  /** New outside addresses one person may invite a day (`INVITES_PER_DAY`, default 20). */
  invitesPerDay: number
  /**
   * How many complete versions of each site and Path to keep besides its current one
   * (`VERSION_RETENTION`, default 0: every version kept); maintenance.ts deletes the rest.
   */
  versionRetention: number
  /**
   * The archive policy (archive-policy.ts), in days, each 0 when off: archive a site nobody has
   * viewed or published for `inactiveDays` (`ARCHIVE_INACTIVE_DAYS`, the `archivePolicy`
   * capability), telling its owners `warnDays` before (`ARCHIVE_WARN_DAYS`, default 7); delete one
   * it archived `deleteArchivedDays` after (`DELETE_ARCHIVED_DAYS`); purge a deleted site's kept
   * files `purgeDeletedDays` after its delete (`PURGE_DELETED_DAYS`).
   */
  archivePolicy: ArchivePolicyConfig
  /**
   * Whether maintenance also sweeps every site, a lap at a time, behind its queue
   * (`MAINTENANCE_SWEEP_ENABLED`, default on; maintenance.ts). Off, only queued sites are
   * maintained.
   */
  maintenanceSweep: boolean
  /** Site servers: who publishes them, what they reach, their limits (`SERVERS*`, `SERVER_*`). */
  servers: ServersConfig
  /** `/auth/dev-login` enabled (never in production) */
  devLogin: boolean
  /** cookies get `Secure` (and the session cookie the `__Host-` prefix) */
  secureCookies: boolean
  /** OAuth redirect URI allowlist (exact URLs and/or `loopback`) */
  oauthRedirectAllowlist: string[]
  /**
   * `MCP_AUTHORIZATION_SERVER`, no trailing slash: an outside authorization server whose tokens
   * `/mcp` also accepts (oauth/external.ts), and the one MCP clients are sent to.
   */
  mcpAuthorizationServer?: string
  oidc: OidcConfig
  /** Every env key, its effective value and whether the env set it (`GET /api/admin/settings`). */
  settings: ConfigSetting[]
  secrets: Secrets
}

export type BaseConfig = Omit<Config, 'secrets'>

export function loadBaseConfig(env: Record<string, string | undefined> = process.env): BaseConfig {
  const e = envSchema.parse(env)
  const production = e.APP_ENV === 'production'
  const appOrigin = new URL(e.APP_ORIGIN).origin
  const siteScheme = e.SITE_SCHEME ?? (production ? 'https' : 'http')
  if (production && !e.ALLOWED_EMAIL_DOMAINS && !e.ALLOWED_EMAILS) {
    throw new Error(
      'ALLOWED_EMAIL_DOMAINS or ALLOWED_EMAILS is required in production (e.g. example.test or you@example.test)'
    )
  }
  if (production && e.LIVE_URL && !e.LIVE_URL.startsWith('wss://')) {
    throw new Error('LIVE_URL must be a wss:// URL in production')
  }
  if (Boolean(e.OIDC_ISSUER) !== Boolean(e.OIDC_CLIENT_ID)) {
    throw new Error('OIDC_ISSUER and OIDC_CLIENT_ID go together')
  }
  if (
    production &&
    e.MCP_AUTHORIZATION_SERVER &&
    !e.MCP_AUTHORIZATION_SERVER.startsWith('https://')
  ) {
    throw new Error('MCP_AUTHORIZATION_SERVER must be an https URL in production')
  }
  if (production && e.OIDC_ISSUER && !e.OIDC_ISSUER.startsWith('https://')) {
    throw new Error('OIDC_ISSUER must be an https URL in production')
  }
  const colors = {
    primary: e.BRAND_PRIMARY,
    primaryContent: e.BRAND_PRIMARY_CONTENT,
    accent: e.BRAND_ACCENT,
    ink: e.BRAND_INK,
    highlight: e.BRAND_HIGHLIGHT,
  }
  const allowedEmailDomains = e.ALLOWED_EMAIL_DOMAINS ?? (e.ALLOWED_EMAILS ? [] : DEV_EMAIL_DOMAINS)
  const allowedEmails = e.ALLOWED_EMAILS ?? []
  const devLogin = e.DEV_LOGIN && !production
  const maySignIn = (email: string) =>
    emailAllowed(email, { allowedDomains: allowedEmailDomains, allowedEmails })
  for (const admin of e.ADMIN_EMAILS ?? []) {
    if (!maySignIn(admin)) {
      throw new Error(
        `ADMIN_EMAILS: ${admin} may not sign in (add it to ALLOWED_EMAILS or its domain to ALLOWED_EMAIL_DOMAINS)`
      )
    }
  }
  const adminEmails = e.ADMIN_EMAILS ?? (devLogin ? DEV_ADMIN_EMAILS.filter(maySignIn) : [])
  const cfg: BaseConfig = {
    appEnv: e.APP_ENV,
    instanceName: e.INSTANCE_NAME,
    appOrigin,
    sitesDomain: e.SITES_DOMAIN.toLowerCase(),
    siteScheme,
    siteCookieDomain: e.SITE_COOKIE_DOMAIN,
    allowedEmailDomains,
    allowedEmails,
    adminEmails,
    brand: definedOnly({
      logoUrl: e.BRAND_LOGO_URL,
      logoDarkUrl: e.BRAND_LOGO_DARK_URL,
      faviconUrl: e.BRAND_FAVICON_URL,
      colors: definedOnly(colors),
    }),
    installCommand: e.INSTALL_COMMAND,
    siteDefaultAccess: e.SITE_DEFAULT_ACCESS,
    pathsPerSite: e.PATHS_PER_SITE_MAX,
    tableName: e.TABLE_NAME,
    databaseSchema: e.DATABASE_SCHEMA,
    sitesBucket: e.SITES_BUCKET,
    kvsArn: e.KVS_ARN,
    ssmPrefix: e.SSM_PREFIX,
    storeDriver: e.STORE_DRIVER ?? (production ? 'dynamo' : 'memory'),
    storageDriver: e.STORAGE_DRIVER ?? (production ? 's3' : 'fs'),
    kvsDriver: e.KVS_DRIVER ?? (production ? 'cloudfront' : 'memory'),
    fsRoot: e.FS_ROOT,
    comments: e.COMMENTS,
    live: e.COMMENTS && e.LIVE && e.LIVE_URL !== undefined,
    liveUrl: e.LIVE_URL,
    devLogin,
    secureCookies: appOrigin.startsWith('https:'),
    oauthRedirectAllowlist: e.OAUTH_REDIRECT_ALLOWLIST
      ? e.OAUTH_REDIRECT_ALLOWLIST.split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : DEFAULT_OAUTH_REDIRECT_ALLOWLIST,
    ...(e.MCP_AUTHORIZATION_SERVER
      ? { mcpAuthorizationServer: e.MCP_AUTHORIZATION_SERVER.replace(/\/+$/, '') }
      : {}),
    oidc: definedOnly({
      issuer: e.OIDC_ISSUER,
      clientId: e.OIDC_CLIENT_ID,
      displayName: e.OIDC_DISPLAY_NAME,
      scopes: e.OIDC_SCOPES?.split(/[\s,]+/).filter(Boolean),
      assumeEmailVerified: e.OIDC_ASSUME_EMAIL_VERIFIED,
    }),
    invites: e.INVITES,
    invitesPerDay: e.INVITES_PER_DAY,
    viewCounts: e.SITE_VIEW_COUNTS,
    siteDelete: e.SITE_DELETE,
    versionRetention: e.VERSION_RETENTION,
    archivePolicy: archivePolicyConfig(e),
    maintenanceSweep: e.MAINTENANCE_SWEEP_ENABLED,
    servers: {
      publish: parseServersPublish(e.SERVERS),
      egress: e.SERVERS_EGRESS,
      maxSites: e.SERVERS_MAX_SITES,
      limits: {
        timeoutSeconds: e.SERVER_TIMEOUT_SECONDS,
        cpuMs: e.SERVER_CPU_MS,
        rps: e.SERVER_RPS,
        environments: e.SERVER_ENVIRONMENTS,
        bodyBytes: e.SERVER_BODY_BYTES,
      },
    },
    settings: [],
  }
  const mail = mailConfig(e, cfg)
  if (mail) cfg.mail = mail
  if (cfg.invites && !cfg.mail) {
    throw new Error('INVITES=on needs email: set MAIL_DRIVER and MAIL_FROM')
  }
  if (cfg.storeDriver === 'dynamo' && !cfg.tableName) throw new Error('TABLE_NAME is required')
  if ((cfg.storageDriver === 's3' || cfg.storageDriver === 'gcs') && !cfg.sitesBucket) {
    throw new Error('SITES_BUCKET is required')
  }
  if (cfg.kvsDriver === 'cloudfront' && !cfg.kvsArn) throw new Error('KVS_ARN is required')
  cfg.settings = settingsOf(env, e, cfg)
  return cfg
}

/**
 * Each env key with the value the instance runs with. Where the instance derives a default
 * (from APP_ENV, other keys, or its own constants), that is the value, not the schema's blank.
 */
function settingsOf(
  env: Record<string, string | undefined>,
  e: z.infer<typeof envSchema>,
  cfg: BaseConfig
): ConfigSetting[] {
  const derived: Partial<Record<EnvKey, SettingValue | undefined>> = {
    APP_ORIGIN: cfg.appOrigin,
    SITES_DOMAIN: cfg.sitesDomain,
    SITE_SCHEME: cfg.siteScheme,
    ALLOWED_EMAIL_DOMAINS: cfg.allowedEmailDomains,
    ALLOWED_EMAILS: cfg.allowedEmails,
    ADMIN_EMAILS: cfg.adminEmails,
    STORE_DRIVER: cfg.storeDriver,
    STORAGE_DRIVER: cfg.storageDriver,
    KVS_DRIVER: cfg.kvsDriver,
    DEV_LOGIN: cfg.devLogin,
    OAUTH_REDIRECT_ALLOWLIST: cfg.oauthRedirectAllowlist,
    OIDC_SCOPES: cfg.oidc.scopes,
    MAIL_FROM_NAME: cfg.mail?.fromName,
  }
  return ENV_KEYS.map(key => ({
    key,
    group: SETTING_GROUP[key],
    value: (key in derived ? derived[key] : (e[key] as SettingValue | undefined)) ?? null,
    set: blank(env[key]) !== undefined,
  }))
}

/**
 * The mail settings, checked. A driver needs MAIL_FROM. Production takes only the cloud drivers,
 * and a sender whose domain is not the sites domain: a sending domain gets DNS records on names
 * under it, which on the sites domain would shadow the wildcard (and break a site of that name).
 * A subdomain of the sites domain is fine when the label under the sites domain is a reserved site
 * name (`mail.<sites domain>`), which is never a site.
 */
function mailConfig(e: z.infer<typeof envSchema>, cfg: BaseConfig): MailConfig | undefined {
  const production = cfg.appEnv === 'production'
  if (!e.MAIL_DRIVER) return undefined
  if (production && (e.MAIL_DRIVER === 'file' || e.MAIL_DRIVER === 'memory')) {
    throw new Error(
      `MAIL_DRIVER must be ses, cloudflare, smtp or acs in production (got ${e.MAIL_DRIVER})`
    )
  }
  if (!e.MAIL_FROM) throw new Error('MAIL_FROM is required with MAIL_DRIVER')
  if (production) {
    const domain = e.MAIL_FROM.slice(e.MAIL_FROM.lastIndexOf('@') + 1)
    const sites = cfg.sitesDomain.replace(/:\d+$/, '')
    if (domain === sites) {
      throw new Error(
        `MAIL_FROM must not be on the sites domain (${sites}); send from a subdomain such as mail.${sites}`
      )
    }
    if (domain.endsWith(`.${sites}`)) {
      const label = domain
        .slice(0, -(sites.length + 1))
        .split('.')
        .at(-1) as string
      if (!RESERVED_SITE_NAMES.includes(label)) {
        throw new Error(
          `MAIL_FROM's domain would shadow the site ${label}.${sites}; send from mail.${sites} or another domain`
        )
      }
    }
  }
  return definedOnly({
    driver: e.MAIL_DRIVER,
    from: e.MAIL_FROM,
    fromName: e.MAIL_FROM_NAME ?? e.INSTANCE_NAME,
    replyTo: e.MAIL_REPLY_TO,
    sesConfigurationSet: e.SES_CONFIGURATION_SET,
    smtp: e.MAIL_DRIVER === 'smtp' ? smtpConfig(e, production) : undefined,
  })
}

/** The `smtp` driver's server, checked: a host, and TLS in production. */
function smtpConfig(e: z.infer<typeof envSchema>, production: boolean): SmtpConfig {
  if (!e.SMTP_HOST) throw new Error('SMTP_HOST is required with MAIL_DRIVER=smtp')
  const security = e.SMTP_SECURITY ?? (e.SMTP_PORT === 465 ? 'tls' : 'starttls')
  if (production && security === 'none') {
    throw new Error('SMTP_SECURITY=none is refused in production: use tls or starttls')
  }
  return definedOnly({
    host: e.SMTP_HOST,
    port: e.SMTP_PORT ?? (security === 'tls' ? 465 : 587),
    security,
    user: e.SMTP_USER,
  })
}

/** Drop undefined fields, so the metadata JSON only carries what is configured. */
function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function tickSecretOf(value: string | undefined): string | undefined {
  const secret = value?.trim()
  if (!secret) return undefined
  if (secret.length < 32) throw new Error('TICK_SECRET must be at least 32 characters')
  return secret
}

/** Secrets from env (dev/tests). A missing client secret is allowed (dev-login still works). */
export function secretsFromEnv(env: Record<string, string | undefined> = process.env): Secrets {
  const sessionSecret = env.SESSION_SECRET?.trim()
  const siteHmacKey = env.SITE_HMAC_KEY?.trim()
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters')
  }
  if (!siteHmacKey || siteHmacKey.length < 32) {
    throw new Error('SITE_HMAC_KEY must be at least 32 characters')
  }
  return {
    oidcClientSecret: env.OIDC_CLIENT_SECRET?.trim() || undefined,
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() || undefined,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || undefined,
    sessionSecret,
    siteHmacKey,
    siteSecretsKey: env.SITE_SECRETS_KEY?.trim() || undefined,
    originVerifySecret: env.ORIGIN_VERIFY_SECRET?.trim() || undefined,
    smtpPassword: env.SMTP_PASSWORD?.trim() || undefined,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    tickSecret: tickSecretOf(env.TICK_SECRET),
    slackSigningSecret: env.SLACK_SIGNING_SECRET?.trim() || undefined,
    slackBotToken: env.SLACK_BOT_TOKEN?.trim() || undefined,
  }
}

/** Whether `email` is one of the instance's admins (ADMIN_EMAILS), now. */
export const isAdminEmail = (config: Pick<Config, 'adminEmails'>, email: string) =>
  config.adminEmails.includes(email)
