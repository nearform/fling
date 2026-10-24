/**
 * Configuration: one zod schema over the env object (rocketpod pattern). Plain vars come from the
 * Lambda environment; secrets come from SSM (`SSM_PREFIX`, loaded once per cold start in
 * platforms/aws/src/secrets.ts) or, when that is unset (dev/tests), from the same-named env vars.
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

const envSchema = z.object({
  APP_ENV: z.preprocess(blank, z.enum(['production', 'development']).default('development')),
  APP_ORIGIN: z.preprocess(blank, z.url().default('http://localhost:3001')),
  SITES_DOMAIN: z.preprocess(blank, z.string().min(1).default('localhost:3002')),
  SITE_SCHEME: z.preprocess(blank, z.enum(['http', 'https']).optional()),
  SITE_COOKIE_DOMAIN: z.preprocess(blank, z.string().min(1).default('localhost')),
  /** Required in production: who may sign in. Dev/tests fall back to DEV_EMAIL_DOMAINS. */
  ALLOWED_EMAIL_DOMAINS: z.preprocess(blank, csvLower.optional()),
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
  STORE_DRIVER: z.preprocess(blank, z.enum(['dynamo', 'memory']).optional()),
  STORAGE_DRIVER: z.preprocess(blank, z.enum(['s3', 'fs']).optional()),
  KVS_DRIVER: z.preprocess(blank, z.enum(['cloudfront', 'memory']).optional()),
  FS_ROOT: optionalString,
  DEV_LOGIN: flag,
  OAUTH_REDIRECT_ALLOWLIST: z.preprocess(blank, z.string().optional()),
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

/** Who may sign in to a dev/test instance when ALLOWED_EMAIL_DOMAINS is unset. */
export const DEV_EMAIL_DOMAINS = ['example.test']

export interface Secrets {
  googleClientId: string
  googleClientSecret: string
  sessionSecret: string
  siteHmacKey: string
  /** CloudFront adds `x-origin-verify: <secret>`; unset → no check. */
  originVerifySecret?: string
}

export interface Config {
  appEnv: 'production' | 'development'
  /** The instance's display name (`INSTANCE_NAME`, default "Fling"). */
  instanceName: string
  /** e.g. https://fling.example.test (no trailing slash) */
  appOrigin: string
  /** host[:port] the site labels hang off, e.g. sites.example.test or localhost:3002 */
  sitesDomain: string
  siteScheme: 'http' | 'https'
  siteCookieDomain: string
  allowedEmailDomains: string[]
  /** Logo, favicon and colours the web applies (`BRAND_*`); empty → the neutral default. */
  brand: InstanceBrand
  /** How the instance tells people to install the CLI (`INSTALL_COMMAND`). */
  installCommand: string
  tableName?: string
  sitesBucket?: string
  kvsArn?: string
  ssmPrefix?: string
  storeDriver: 'dynamo' | 'memory'
  storageDriver: 's3' | 'fs'
  kvsDriver: 'cloudfront' | 'memory'
  fsRoot?: string
  /** `/auth/dev-login` enabled (never in production) */
  devLogin: boolean
  /** cookies get `Secure` (and the session cookie the `__Host-` prefix) */
  secureCookies: boolean
  /** OAuth redirect URI allowlist (exact URLs and/or `loopback`) */
  oauthRedirectAllowlist: string[]
  secrets: Secrets
}

export type BaseConfig = Omit<Config, 'secrets'>

export function loadBaseConfig(env: Record<string, string | undefined> = process.env): BaseConfig {
  const e = envSchema.parse(env)
  const production = e.APP_ENV === 'production'
  const appOrigin = new URL(e.APP_ORIGIN).origin
  const siteScheme = e.SITE_SCHEME ?? (production ? 'https' : 'http')
  if (production && !e.ALLOWED_EMAIL_DOMAINS) {
    throw new Error('ALLOWED_EMAIL_DOMAINS is required in production (e.g. example.test)')
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
    allowedEmailDomains: e.ALLOWED_EMAIL_DOMAINS ?? DEV_EMAIL_DOMAINS,
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
    devLogin: e.DEV_LOGIN && !production,
    secureCookies: appOrigin.startsWith('https:'),
    oauthRedirectAllowlist: e.OAUTH_REDIRECT_ALLOWLIST
      ? e.OAUTH_REDIRECT_ALLOWLIST.split(',')
          .map(s => s.trim())
          .filter(Boolean)
      : DEFAULT_OAUTH_REDIRECT_ALLOWLIST,
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

/** Secrets from env (dev/tests). Missing Google creds are allowed (dev-login still works). */
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
    googleClientId: env.GOOGLE_CLIENT_ID?.trim() ?? '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET?.trim() ?? '',
    sessionSecret,
    siteHmacKey,
    originVerifySecret: env.ORIGIN_VERIFY_SECRET?.trim() || undefined,
  }
}
