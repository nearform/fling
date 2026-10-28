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
  // MAIL_* and SES_* come from MAIL, which also renders the send_email binding they need.
  const mailKey = Object.keys(instance).find(k => /^(MAIL|SES)_/.test(k))
  if (mailKey) {
    throw new Error(`CF_DEPLOY_CONFIG.INSTANCE.${mailKey} is not allowed: email is set in MAIL`)
  }
  checkMail(config.MAIL)
  // Who may sign in has no default: whole domains, individual addresses, or both.
  const set = k => typeof instance[k] === 'string' && instance[k].trim() !== ''
  if (!set('ALLOWED_EMAIL_DOMAINS') && !set('ALLOWED_EMAILS')) {
    throw new Error(
      'CF_DEPLOY_CONFIG.INSTANCE needs ALLOWED_EMAIL_DOMAINS or ALLOWED_EMAILS (or both)'
    )
  }
  return config
}

/** One address, as the API's config takes MAIL_FROM and MAIL_REPLY_TO. */
const ADDRESS_RE = /^[^@\s<>"(),;:\\[\]]+@[^@\s<>"(),;:\\[\]]+\.[^@\s<>"(),;:\\[\]]+$/

/**
 * `MAIL` (optional): `{ FROM, FROM_NAME?, REPLY_TO? }`. FROM is an address on a domain onboarded
 * to Email Service; the Worker refuses to start if that domain is the sites domain itself.
 */
export function checkMail(mail) {
  if (mail === undefined) return
  if (typeof mail !== 'object' || mail === null || Array.isArray(mail)) {
    throw new Error('CF_DEPLOY_CONFIG.MAIL must be an object: { FROM, FROM_NAME?, REPLY_TO? }')
  }
  const unknown = Object.keys(mail).filter(k => !['FROM', 'FROM_NAME', 'REPLY_TO'].includes(k))
  if (unknown.length) {
    throw new Error(`CF_DEPLOY_CONFIG.MAIL has unknown keys: ${unknown.join(', ')}`)
  }
  if (typeof mail.FROM !== 'string' || !ADDRESS_RE.test(mail.FROM.trim())) {
    throw new Error(
      'CF_DEPLOY_CONFIG.MAIL.FROM must be an email address, e.g. fling@mail.example.com'
    )
  }
  if (
    mail.FROM_NAME !== undefined &&
    (typeof mail.FROM_NAME !== 'string' || !mail.FROM_NAME.trim() || /[\r\n]/.test(mail.FROM_NAME))
  ) {
    throw new Error('CF_DEPLOY_CONFIG.MAIL.FROM_NAME must be one line of text')
  }
  if (
    mail.REPLY_TO !== undefined &&
    (typeof mail.REPLY_TO !== 'string' || !ADDRESS_RE.test(mail.REPLY_TO.trim()))
  ) {
    throw new Error('CF_DEPLOY_CONFIG.MAIL.REPLY_TO must be an email address')
  }
}

/** The every-minute cron that drains the notifications' outbox: on only with MAIL. */
export const MAIL_CRON = '* * * * *'

/** The binding, crons and vars MAIL gives the Worker: no binding, cron or vars without it. */
function mailConfig(template, mail) {
  const crons = (template.triggers?.crons ?? []).filter(c => c !== MAIL_CRON)
  if (!mail) return { triggers: { ...template.triggers, crons }, vars: {} }
  const from = mail.FROM.trim().toLowerCase()
  return {
    send_email: [{ name: 'EMAIL', allowed_sender_addresses: [from] }],
    triggers: { ...template.triggers, crons: [...crons, MAIL_CRON] },
    vars: {
      MAIL_DRIVER: 'cloudflare',
      MAIL_FROM: from,
      ...(mail.FROM_NAME ? { MAIL_FROM_NAME: mail.FROM_NAME.trim() } : {}),
      ...(mail.REPLY_TO ? { MAIL_REPLY_TO: mail.REPLY_TO.trim().toLowerCase() } : {}),
    },
  }
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
 * and vars, plus, with `MAIL`, the Email Service binding, the drain's cron and the mail vars. The dev vars are dropped, never merged: production gets only what is configured.
 */
export function renderWranglerConfig(template, config, outDir) {
  checkDeployConfig(config)
  const appHost = new URL(config.APP_ORIGIN).hostname
  const mail = mailConfig(template, config.MAIL)
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
      // The live rooms' sockets are the Worker's own (src/live.ts); INSTANCE.LIVE=false turns them off.
      LIVE_URL: `wss://${appHost}/api/live`,
      STORE_DRIVER: 'd1',
      STORAGE_DRIVER: 'r2',
      KVS_DRIVER: 'workers-kv',
      ...mail.vars,
    },
    triggers: mail.triggers,
  }
  if (mail.send_email) out.send_email = mail.send_email
  else delete out.send_email
  delete out.dev
  delete out.$schema
  return out
}
