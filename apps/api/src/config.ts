/**
 * Configuration: one zod schema over the env object (rocketpod pattern). Plain vars come from the
 * Lambda environment; secrets come from SSM (`SSM_PREFIX`, loaded once per cold start in
 * platforms/aws/src/secrets.ts) or, when that is unset (dev/tests), from the same-named env vars.
 * Sign-in (`OIDC_*`) is resolved from both in auth/oidc.ts.
 */
import { DEFAULT_INSTALL_COMMAND, HEX_COLOR_RE, type InstanceBrand } from '@fling/shared'
import { z } from 'zod'

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
  ALLOWED_EMAILS: z.preprocess(
    blank,
    csvLower.pipe(z.array(z.string().regex(EMAIL_RE, 'must be an email address'))).optional()
  ),
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
  COMMENTS: flagDefaultOn,
})

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

export interface Secrets {
  /** The OIDC client's secret (`OIDC_CLIENT_SECRET`; SSM `oidc-client-secret`). */
  oidcClientSecret?: string
  /**
   * Deprecated: the Google OAuth client from before generic OIDC (`GOOGLE_CLIENT_ID/SECRET`; SSM
   * `google-client-id/secret`). Used, as the issuer https://accounts.google.com, only when
   * OIDC_ISSUER is unset.
   */
  googleClientId?: string
  googleClientSecret?: string
  sessionSecret: string
  siteHmacKey: string
  /** CloudFront adds `x-origin-verify: <secret>`; unset → no check. */
  originVerifySecret?: string
}

/** The identity provider from env (`OIDC_*`); the client secret is in Secrets. */
export interface OidcConfig {
  /** Exactly the issuer's `iss` (e.g. https://accounts.google.com); unset → legacy/dev. */
  issuer?: string
  clientId?: string
  /** What the sign-in button says ("Sign in with …"); default derived from the issuer. */
  displayName?: string
  /** Default `openid email profile`. */
  scopes?: string[]
  /** Treat a missing `email_verified` claim as verified (an explicit `false` is still refused). */
  assumeEmailVerified: boolean
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
  /** Logo, favicon and colours the web applies (`BRAND_*`); empty → the neutral default. */
  brand: InstanceBrand
  /** How the instance tells people to install the CLI (`INSTALL_COMMAND`). */
  installCommand: string
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
  /** `/auth/dev-login` enabled (never in production) */
  devLogin: boolean
  /** cookies get `Secure` (and the session cookie the `__Host-` prefix) */
  secureCookies: boolean
  /** OAuth redirect URI allowlist (exact URLs and/or `loopback`) */
  oauthRedirectAllowlist: string[]
  oidc: OidcConfig
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
  const cfg: BaseConfig = {
    appEnv: e.APP_ENV,
    instanceName: e.INSTANCE_NAME,
    appOrigin,
    sitesDomain: e.SITES_DOMAIN.toLowerCase(),
    siteScheme,
    siteCookieDomain: e.SITE_COOKIE_DOMAIN,
    allowedEmailDomains: e.ALLOWED_EMAIL_DOMAINS ?? (e.ALLOWED_EMAILS ? [] : DEV_EMAIL_DOMAINS),
    allowedEmails: e.ALLOWED_EMAILS ?? [],
    brand: definedOnly({
      logoUrl: e.BRAND_LOGO_URL,
      logoDarkUrl: e.BRAND_LOGO_DARK_URL,
      faviconUrl: e.BRAND_FAVICON_URL,
      colors: definedOnly(colors),
    }),
    installCommand: e.INSTALL_COMMAND,
    tableName: e.TABLE_NAME,
    sitesBucket: e.SITES_BUCKET,
    kvsArn: e.KVS_ARN,
    ssmPrefix: e.SSM_PREFIX,
    storeDriver: e.STORE_DRIVER ?? (production ? 'dynamo' : 'memory'),
    storageDriver: e.STORAGE_DRIVER ?? (production ? 's3' : 'fs'),
    kvsDriver: e.KVS_DRIVER ?? (production ? 'cloudfront' : 'memory'),
    fsRoot: e.FS_ROOT,
    comments: e.COMMENTS,
    devLogin: e.DEV_LOGIN && !production,
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
  }
  if (cfg.storeDriver === 'dynamo' && !cfg.tableName) throw new Error('TABLE_NAME is required')
  if (cfg.storageDriver === 's3' && !cfg.sitesBucket) throw new Error('SITES_BUCKET is required')
  if (cfg.kvsDriver === 'cloudfront' && !cfg.kvsArn) throw new Error('KVS_ARN is required')
  return cfg
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
