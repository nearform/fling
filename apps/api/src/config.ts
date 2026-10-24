/**
 * Configuration: one zod schema over the env object (rocketpod pattern). Plain vars come from the
 * Lambda environment; secrets come from SSM (`SSM_PREFIX`, loaded once per cold start in
 * platforms/aws/src/secrets.ts) or, when that is unset (dev/tests), from the same-named env vars.
 */
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
  ALLOWED_EMAIL_DOMAINS: z.preprocess(blank, csvLower.default(['nearform.com'])),
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
  /** e.g. https://fling.labs.nearform.com (no trailing slash) */
  appOrigin: string
  /** host[:port] the site labels hang off, e.g. fling.labs.nearform.com or localhost:3002 */
  sitesDomain: string
  siteScheme: 'http' | 'https'
  siteCookieDomain: string
  allowedEmailDomains: string[]
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
  const cfg: BaseConfig = {
    appEnv: e.APP_ENV,
    appOrigin,
    sitesDomain: e.SITES_DOMAIN.toLowerCase(),
    siteScheme,
    siteCookieDomain: e.SITE_COOKIE_DOMAIN,
    allowedEmailDomains: e.ALLOWED_EMAIL_DOMAINS,
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
