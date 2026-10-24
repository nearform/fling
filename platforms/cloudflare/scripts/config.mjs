// The Worker's config: reading wrangler.jsonc and rendering the deployable one from it and an
// instance's deploy config (CF_DEPLOY_CONFIG). Used by setup.mjs, render-config.mjs and migrate.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const TEMPLATE = join(ROOT, 'wrangler.jsonc')

/** JSON with `//` and block comments (outside strings) and trailing commas. */
export function parseJsonc(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
      if (i === 0) throw new Error('unterminated comment')
    } else {
      out += c
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

export const readJsonc = path => parseJsonc(readFileSync(path, 'utf8'))

/**
 * The deploy config contract (CF_DEPLOY_CONFIG), the Cloudflare counterpart of AWS_DEPLOY_CONFIG.
 * Nothing in it is secret.
 */
export const DEPLOY_KEYS = {
  CLOUDFLARE_ACCOUNT_ID: 'the account the Worker, D1, R2 and KV live in',
  WORKER_NAME: 'the Worker (e.g. fling)',
  ZONE_NAME: 'the zone both hostnames are in (e.g. example.com)',
  APP_ORIGIN: 'https://<app host>, served by the Worker as a Custom Domain',
  SITES_DOMAIN: 'sites are <name>.<SITES_DOMAIN>, routed by a wildcard route',
  D1_DATABASE_NAME: 'the D1 database',
  D1_DATABASE_ID: "the D1 database's id",
  R2_BUCKET: 'the R2 bucket for site files',
  KV_NAMESPACE_ID: "the KV namespace's id (the routes' fast copy)",
}

export function checkDeployConfig(config) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('CF_DEPLOY_CONFIG must be a JSON object')
  }
  const missing = Object.keys(DEPLOY_KEYS).filter(
    k => typeof config[k] !== 'string' || !config[k].trim()
  )
  if (missing.length) throw new Error(`CF_DEPLOY_CONFIG is missing ${missing.join(', ')}`)
  const origin = new URL(config.APP_ORIGIN)
  if (origin.protocol !== 'https:' || origin.origin !== config.APP_ORIGIN.replace(/\/$/, '')) {
    throw new Error(
      'CF_DEPLOY_CONFIG.APP_ORIGIN must be an https origin, e.g. https://fling.example.com'
    )
  }
  if (!/^[a-z0-9.-]+$/.test(config.SITES_DOMAIN)) {
    throw new Error('CF_DEPLOY_CONFIG.SITES_DOMAIN must be a hostname, e.g. sites.example.com')
  }
  const inZone = host => host === config.ZONE_NAME || host.endsWith(`.${config.ZONE_NAME}`)
  if (!inZone(origin.hostname) || !inZone(config.SITES_DOMAIN)) {
    throw new Error('the app host and SITES_DOMAIN must both be in ZONE_NAME')
  }
  const instance = config.INSTANCE ?? {}
  if (typeof instance !== 'object' || Array.isArray(instance)) {
    throw new Error('CF_DEPLOY_CONFIG.INSTANCE must be an object of ENV_STYLE keys')
  }
  for (const [k, v] of Object.entries(instance)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || !['string', 'number', 'boolean'].includes(typeof v)) {
      throw new Error(`CF_DEPLOY_CONFIG.INSTANCE.${k} must be a string, number or boolean`)
    }
  }
  if (typeof instance.ALLOWED_EMAIL_DOMAINS !== 'string' || !instance.ALLOWED_EMAIL_DOMAINS) {
    throw new Error('CF_DEPLOY_CONFIG.INSTANCE.ALLOWED_EMAIL_DOMAINS is required')
  }
  return config
}

/** The longest dot-suffix two hosts share: the domain the `fling_site` cookie is set on. */
export function commonParent(a, b) {
  const x = a.split('.').reverse()
  const y = b.split('.').reverse()
  const shared = []
  for (let i = 0; i < Math.min(x.length, y.length) && x[i] === y[i]; i++) shared.push(x[i])
  if (shared.length < 2) throw new Error(`${a} and ${b} share no registrable domain`)
  return shared.reverse().join('.')
}

/** Rebase a path in the template (relative to ROOT) for a config written to `dir`. */
const rebase = (path, dir) => {
  const rel = join(ROOT, path)
  const parts = dir.replace(ROOT, '').split('/').filter(Boolean)
  return `${'../'.repeat(parts.length)}${rel.replace(ROOT, '')}`
}

/**
 * The deployable wrangler config: the template with this instance's account, resources, routes
 * and vars. The dev vars are dropped, never merged: production gets only what is configured.
 */
export function renderWranglerConfig(template, config, outDir) {
  checkDeployConfig(config)
  const appHost = new URL(config.APP_ORIGIN).hostname
  const instance = Object.fromEntries(
    Object.entries(config.INSTANCE ?? {}).map(([k, v]) => [k, String(v)])
  )
  const out = {
    ...template,
    name: config.WORKER_NAME,
    account_id: config.CLOUDFLARE_ACCOUNT_ID,
    main: rebase(template.main, outDir),
    assets: { ...template.assets, directory: rebase(template.assets.directory, outDir) },
    d1_databases: template.d1_databases.map(db => ({
      ...db,
      database_name: config.D1_DATABASE_NAME,
      database_id: config.D1_DATABASE_ID,
      migrations_dir: rebase(db.migrations_dir, outDir),
    })),
    r2_buckets: template.r2_buckets.map(b => ({ ...b, bucket_name: config.R2_BUCKET })),
    kv_namespaces: template.kv_namespaces.map(kv => ({ ...kv, id: config.KV_NAMESPACE_ID })),
    routes: [
      { pattern: appHost, custom_domain: true },
      { pattern: `*.${config.SITES_DOMAIN}/*`, zone_name: config.ZONE_NAME },
    ],
    vars: {
      ...instance,
      // The deployment's plumbing wins over INSTANCE, as the function's environment does on AWS.
      APP_ENV: 'production',
      APP_ORIGIN: config.APP_ORIGIN.replace(/\/$/, ''),
      SITES_DOMAIN: config.SITES_DOMAIN,
      SITE_SCHEME: 'https',
      SITE_COOKIE_DOMAIN: commonParent(appHost, config.SITES_DOMAIN),
      STORE_DRIVER: 'd1',
      STORAGE_DRIVER: 'r2',
      KVS_DRIVER: 'workers-kv',
    },
  }
  delete out.dev
  delete out.$schema
  return out
}
