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
  STORE_DRIVER: z.preprocess(blank, z.enum(['dynamo', 'd1', 'memory']).optional()),
  STORAGE_DRIVER: z.preprocess(blank, z.enum(['s3', 'r2', 'fs']).optional()),
  KVS_DRIVER: z.preprocess(blank, z.enum(['cloudfront', 'workers-kv', 'memory']).optional()),
  FS_ROOT: optionalString,
  DEV_LOGIN: flag,
  OAUTH_REDIRECT_ALLOWLIST: z.preprocess(blank, z.string().optional()),
  OIDC_ISSUER: z.preprocess(blank, z.url().optional()),
  OIDC_CLIENT_ID: optionalString,
  OIDC_DISPLAY_NAME: z.preprocess(blank, z.string().min(1).max(60).optional()),
  OIDC_SCOPES: optionalString,
  OIDC_ASSUME_EMAIL_VERIFIED: flag,
  SITE_DEFAULT_ACCESS: z.preprocess(blank, z.enum(DEFAULT_ACCESS_LEVELS).default('only_me')),
  COMMENTS: flagDefaultOn,
  LIVE: flagDefaultOn,
  LIVE_URL: z.preprocess(
    blank,
    z
      .url()
      .refine(v => /^wss?:\/\//.test(v), 'must be a ws:// or wss:// URL')
      .optional()
  ),
  MAIL_DRIVER: z.preprocess(blank, z.enum(['ses', 'cloudflare', 'file', 'memory']).optional()),
  MAIL_FROM: emailAddress,
  MAIL_FROM_NAME: headerText,
  MAIL_REPLY_TO: emailAddress,
  SES_CONFIGURATION_SET: optionalString,
  /** Outside invitations: off unless `on` (or true/yes/1); on needs mail. */
  INVITES: flag,
  INVITES_PER_DAY: z.preprocess(blank, z.coerce.number().int().positive().default(20)),
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
  DEV_LOGIN: 'sign_in',
  APP_ORIGIN: 'sites',
  SITES_DOMAIN: 'sites',
  SITE_SCHEME: 'sites',
  SITE_COOKIE_DOMAIN: 'sites',
  SITE_DEFAULT_ACCESS: 'sites',
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
  MAIL_DRIVER: 'mail',
  MAIL_FROM: 'mail',
  MAIL_FROM_NAME: 'mail',
  MAIL_REPLY_TO: 'mail',
  SES_CONFIGURATION_SET: 'mail',
  APP_ENV: 'platform',
  TABLE_NAME: 'platform',
  SITES_BUCKET: 'platform',
  KVS_ARN: 'platform',
  SSM_PREFIX: 'platform',
  STORE_DRIVER: 'platform',
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
 * OAuth redirect URIs any client (DCR or CIMD) may use. Exact URLs, plus the keyword `loopback`
 * for `http://localhost|127.0.0.1|[::1]:<any port>/<any path>` (Claude Code, MCP Inspector).
 */
export const DEFAULT_OAUTH_REDIRECT_ALLOWLIST = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
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
  /** CloudFront adds `x-origin-verify: <secret>`; unset → no check. */
  originVerifySecret?: string
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
  originVerifySecret: { name: 'ORIGIN_VERIFY_SECRET', group: 'platform' },
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
   * `.fling-dev/mail/`); a platform supplies `ses` or `cloudflare`. Production takes only those two.
   */
  driver: 'ses' | 'cloudflare' | 'file' | 'memory'
  /** The sender address (`MAIL_FROM`), on a domain that is not the sites domain. */
  from: string
  /** The sender's display name (`MAIL_FROM_NAME`, default INSTANCE_NAME). */
  fromName: string
  /** The operator's reply-to address on every email (`MAIL_REPLY_TO`); never the actor's. */
  replyTo?: string
  /** AWS: the SES configuration set to name on each send; unset, the identity's default applies. */
  sesConfigurationSet?: string
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
  tableName?: string
  sitesBucket?: string
  kvsArn?: string
  ssmPrefix?: string
  /**
   * Which adapter each port uses. The core has the dev/test ones (memory, fs); a platform entry
   * supplies the others (platforms/aws: dynamo, s3, cloudfront; platforms/cloudflare: d1, r2,
   * workers-kv). Production defaults to the AWS ones, as before there was a second platform.
   */
  storeDriver: 'dynamo' | 'd1' | 'memory'
  storageDriver: 's3' | 'r2' | 'fs'
  kvsDriver: 'cloudfront' | 'workers-kv' | 'memory'
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
  /** New outside addresses one person may invite a day (`INVITES_PER_DAY`, default 20). */
  invitesPerDay: number
  /** `/auth/dev-login` enabled (never in production) */
  devLogin: boolean
  /** cookies get `Secure` (and the session cookie the `__Host-` prefix) */
  secureCookies: boolean
  /** OAuth redirect URI allowlist (exact URLs and/or `loopback`) */
  oauthRedirectAllowlist: string[]
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
    tableName: e.TABLE_NAME,
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
    oidc: definedOnly({
      issuer: e.OIDC_ISSUER,
      clientId: e.OIDC_CLIENT_ID,
      displayName: e.OIDC_DISPLAY_NAME,
      scopes: e.OIDC_SCOPES?.split(/[\s,]+/).filter(Boolean),
      assumeEmailVerified: e.OIDC_ASSUME_EMAIL_VERIFIED,
    }),
    invites: e.INVITES,
    invitesPerDay: e.INVITES_PER_DAY,
    settings: [],
  }
  const mail = mailConfig(e, cfg)
  if (mail) cfg.mail = mail
  if (cfg.invites && !cfg.mail) {
    throw new Error('INVITES=on needs email: set MAIL_DRIVER and MAIL_FROM')
  }
  if (cfg.storeDriver === 'dynamo' && !cfg.tableName) throw new Error('TABLE_NAME is required')
  if (cfg.storageDriver === 's3' && !cfg.sitesBucket) throw new Error('SITES_BUCKET is required')
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
  if (production && e.MAIL_DRIVER !== 'ses' && e.MAIL_DRIVER !== 'cloudflare') {
    throw new Error(`MAIL_DRIVER must be ses or cloudflare in production (got ${e.MAIL_DRIVER})`)
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
  })
}

/** Drop undefined fields, so the metadata JSON only carries what is configured. */
function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
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
    originVerifySecret: env.ORIGIN_VERIFY_SECRET?.trim() || undefined,
  }
}

/** Whether `email` is one of the instance's admins (ADMIN_EMAILS), now. */
export const isAdminEmail = (config: Pick<Config, 'adminEmails'>, email: string) =>
  config.adminEmails.includes(email)
