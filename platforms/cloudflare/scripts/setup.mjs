// Set up a Fling instance on a Cloudflare account, once (DEPLOY.md, "Setup"). Idempotent: run it
// again to pick up where it stopped, or to change the instance's values; it creates only what is
// missing and never deletes anything.
//
//   node scripts/setup.mjs [--account-id …] [--worker fling] [--zone example.com]
//     [--app-host fling.example.com] [--sites-domain fling.example.com]
//     [--email-domains example.com] [--allowed-emails you@example.com]
//     [--admin-emails you@example.com]   (optional, never asked for; '' removes them)
//     [--site-default-access only_me|members]   (optional, never asked for; '' removes it)
//     [--oidc-issuer https://…] [--oidc-client-id …]
//     [--instance-name Fling] [--location weur] [--out deploy-config.json]
//     [--oidc-client-secret-file path]   (instead of the prompt, e.g. when stdin isn't a terminal)
//
// Anything not passed is asked for (defaults from an earlier run's --out file). It:
//   1. checks wrangler is signed in (`wrangler login`, or CLOUDFLARE_API_TOKEN);
//   2. creates the D1 database, the R2 bucket and the KV namespace unless they exist;
//   3. writes the deploy config (CF_DEPLOY_CONFIG) to --out, and dist/wrangler.jsonc from it;
//   4. applies the D1 schema;
//   5. sets the Worker's secrets that are missing: SESSION_SECRET and SITE_HMAC_KEY (random) and
//      OIDC_CLIENT_SECRET (asked for, never echoed);
//   6. prints what is left to do by hand: DNS, the certificate, GitHub, the first deploy.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { checkDeployConfig, ROOT } from './config.mjs'

const { values: args } = parseArgs({
  options: {
    'account-id': { type: 'string' },
    worker: { type: 'string' },
    zone: { type: 'string' },
    'app-host': { type: 'string' },
    'sites-domain': { type: 'string' },
    'email-domains': { type: 'string' },
    'allowed-emails': { type: 'string' },
    'admin-emails': { type: 'string' },
    'site-default-access': { type: 'string' },
    'oidc-issuer': { type: 'string' },
    'oidc-client-id': { type: 'string' },
    'oidc-client-secret-file': { type: 'string' },
    'instance-name': { type: 'string' },
    location: { type: 'string' },
    out: { type: 'string', default: 'deploy-config.json' },
  },
})

const out = resolve(ROOT, args.out)
const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {}
const wranglerBin = join(ROOT, 'node_modules', '.bin', 'wrangler')
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' }

function wrangler(argv, opts = {}) {
  return execFileSync(wranglerBin, argv, {
    cwd: ROOT,
    env: opts.env ?? env,
    encoding: 'utf8',
    input: opts.input,
    stdio: [opts.input === undefined ? 'inherit' : 'pipe', 'pipe', opts.quiet ? 'pipe' : 'inherit'],
  })
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = (question, fallback) =>
  new Promise(r =>
    rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `, a =>
      r(a.trim() || fallback || '')
    )
  )

/** Ask without echoing (for the OIDC client secret). */
function askSecret(question) {
  return new Promise(r => {
    process.stdout.write(`${question}: `)
    const write = rl._writeToOutput
    rl._writeToOutput = () => {}
    rl.question('', answer => {
      rl._writeToOutput = write
      process.stdout.write('\n')
      r(answer.trim())
    })
  })
}

async function value(flag, question, fallback) {
  if (args[flag]) return args[flag]
  const answer = await ask(question, fallback)
  if (!answer) throw new Error(`${question} is required`)
  return answer
}

const step = title => console.log(`\n▸ ${title}`)

step('Wrangler sign-in')
wrangler(['whoami'])

const accountId = await value(
  'account-id',
  'Cloudflare account id',
  previous.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID
)
env.CLOUDFLARE_ACCOUNT_ID = accountId
const worker = await value('worker', 'Worker name', previous.WORKER_NAME ?? 'fling')
const zone = await value(
  'zone',
  'Zone (your domain in Cloudflare, e.g. example.com)',
  previous.ZONE_NAME
)
const appHost = await value(
  'app-host',
  'App hostname',
  previous.APP_ORIGIN ? new URL(previous.APP_ORIGIN).hostname : `${worker}.${zone}`
)
const sitesDomain = await value(
  'sites-domain',
  'Sites domain (sites are <name>.<this>; the app hostname itself is the usual choice)',
  previous.SITES_DOMAIN ?? appHost
)
const instance = { ...(previous.INSTANCE ?? {}) }
// Who may sign in: whole domains, individual addresses (e.g. your own @gmail.com), or both.
const emailDomains =
  args['email-domains'] ??
  (await ask(
    'Email domains allowed to sign in (comma-separated; blank: none)',
    instance.ALLOWED_EMAIL_DOMAINS
  ))
const allowedEmails =
  args['allowed-emails'] ??
  (await ask(
    `Individual email addresses allowed to sign in (comma-separated${emailDomains ? '; blank: none' : ''})`,
    instance.ALLOWED_EMAILS
  ))
if (!emailDomains && !allowedEmails) {
  throw new Error('Allow at least one email domain or email address to sign in')
}
for (const [key, v] of [
  ['ALLOWED_EMAIL_DOMAINS', emailDomains],
  ['ALLOWED_EMAILS', allowedEmails],
]) {
  if (v) instance[key] = v
  else delete instance[key]
}
// The instance's admins (users list, impersonation): only from the flag, so runs without a
// terminal don't stop to ask. Each must be admitted by the two above (the Worker checks).
if (args['admin-emails'] !== undefined) {
  if (args['admin-emails'].trim()) instance.ADMIN_EMAILS = args['admin-emails'].trim()
  else delete instance.ADMIN_EMAILS
}
// Who can open a new site that names no access level: only from the flag, like the admins.
if (args['site-default-access'] !== undefined) {
  const access = args['site-default-access'].trim()
  if (access && access !== 'only_me' && access !== 'members') {
    throw new Error('--site-default-access must be only_me or members')
  }
  if (access) instance.SITE_DEFAULT_ACCESS = access
  else delete instance.SITE_DEFAULT_ACCESS
}
instance.INSTANCE_NAME = await value(
  'instance-name',
  'Instance name',
  instance.INSTANCE_NAME ?? 'Fling'
)
const issuer =
  args['oidc-issuer'] ?? (await ask('OIDC issuer (blank: none yet)', instance.OIDC_ISSUER))
if (issuer) {
  instance.OIDC_ISSUER = issuer
  instance.OIDC_CLIENT_ID = await value('oidc-client-id', 'OIDC client id', instance.OIDC_CLIENT_ID)
}

step('Resources')
const d1Name = worker
const databases = JSON.parse(wrangler(['d1', 'list', '--json'], { quiet: true }))
let database = databases.find(d => d.name === d1Name)
if (database) {
  console.log(`D1 ${d1Name}: exists (${database.uuid})`)
} else {
  wrangler(['d1', 'create', d1Name, ...(args.location ? ['--location', args.location] : [])])
  database = JSON.parse(wrangler(['d1', 'list', '--json'], { quiet: true })).find(
    d => d.name === d1Name
  )
  if (!database) throw new Error(`D1 ${d1Name} was not created`)
}

const bucket = `${worker}-sites`
const buckets = wrangler(['r2', 'bucket', 'list'], { quiet: true })
if (new RegExp(`^name:\\s+${bucket}\\s*$`, 'm').test(buckets)) {
  console.log(`R2 ${bucket}: exists`)
} else {
  wrangler([
    'r2',
    'bucket',
    'create',
    bucket,
    ...(args.location ? ['--location', args.location] : []),
  ])
}

const kvTitle = `${worker}-routes`
const listKv = () => JSON.parse(wrangler(['kv', 'namespace', 'list'], { quiet: true }))
let kv = listKv().find(n => n.title === kvTitle)
if (kv) {
  console.log(`KV ${kvTitle}: exists (${kv.id})`)
} else {
  wrangler(['kv', 'namespace', 'create', kvTitle])
  kv = listKv().find(n => n.title === kvTitle)
  if (!kv) throw new Error(`KV ${kvTitle} was not created`)
}

step('Deploy config')
const config = checkDeployConfig({
  CLOUDFLARE_ACCOUNT_ID: accountId,
  WORKER_NAME: worker,
  ZONE_NAME: zone,
  APP_ORIGIN: `https://${appHost}`,
  SITES_DOMAIN: sitesDomain,
  D1_DATABASE_NAME: d1Name,
  D1_DATABASE_ID: database.uuid,
  R2_BUCKET: bucket,
  KV_NAMESPACE_ID: kv.id,
  INSTANCE: instance,
  // Email (DEPLOY.md, Email) is added by hand; setup keeps it.
  ...(previous.MAIL ? { MAIL: previous.MAIL } : {}),
})
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`)
console.log(`wrote ${out}`)
const rendered = join(ROOT, 'dist', 'wrangler.jsonc')
execFileSync(process.execPath, [join(ROOT, 'scripts', 'render-config.mjs'), out], {
  cwd: ROOT,
  stdio: 'inherit',
})

step('D1 schema')
wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', rendered])

step('Secrets')
let existing = []
try {
  existing = JSON.parse(
    wrangler(['secret', 'list', '--format', 'json', '--config', rendered], { quiet: true })
  ).map(s => s.name)
} catch {
  // the Worker doesn't exist yet: every secret is missing
}
const secrets = {}
for (const name of ['SESSION_SECRET', 'SITE_HMAC_KEY']) {
  if (existing.includes(name)) console.log(`${name}: set`)
  else secrets[name] = randomBytes(32).toString('base64url')
}
if (instance.OIDC_ISSUER && !existing.includes('OIDC_CLIENT_SECRET')) {
  const oidcSecret = args['oidc-client-secret-file']
    ? readFileSync(resolve(args['oidc-client-secret-file']), 'utf8').trim()
    : await askSecret('OIDC client secret (blank: set it later)')
  if (oidcSecret) secrets.OIDC_CLIENT_SECRET = oidcSecret
} else if (existing.includes('OIDC_CLIENT_SECRET')) {
  console.log('OIDC_CLIENT_SECRET: set')
}
rl.close()
if (Object.keys(secrets).length) {
  // On stdin, never on the command line. Creates the Worker (empty) if it doesn't exist yet.
  wrangler(['secret', 'bulk', '--config', rendered], { input: JSON.stringify(secrets) })
  console.log(`set ${Object.keys(secrets).join(', ')}`)
}

const sitesParent = sitesDomain === zone ? null : sitesDomain
console.log(`
Done. Left to do by hand (DEPLOY.md has the details):

  1. DNS: a proxied record for the sites wildcard, e.g.
       *.${sitesDomain}  AAAA  100::  (Proxied)
     (the app hostname ${appHost} is a Worker Custom Domain: the deploy creates its record).
  2. TLS: ${
    sitesParent
      ? `*.${sitesDomain} is below the zone's first level, which Universal SSL does not cover:
     order an Advanced Certificate for *.${sitesDomain} (SSL/TLS → Edge Certificates).`
      : `*.${zone} is covered by Universal SSL.`
  }
  3. GitHub (repository → Settings → Secrets and variables → Actions):
       variable CF_DEPLOY_CONFIG = the contents of ${args.out}
         gh variable set CF_DEPLOY_CONFIG < platforms/cloudflare/${args.out}
       secret   CLOUDFLARE_API_TOKEN (permissions in DEPLOY.md)
       secret   FLING_E2E_API_KEY, after the first deploy (an API key of a test user)
  4. Deploy: run the "Deploy (Cloudflare)" workflow, or locally:
       CF_DEPLOY_CONFIG="$(cat platforms/cloudflare/${args.out})" \\
         pnpm --filter @fling/platform-cloudflare run deploy
`)
