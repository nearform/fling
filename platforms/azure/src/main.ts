/**
 * The container image's entry point (Dockerfile; bundled to dist/main.mjs). One image, three
 * uses, all configured from the environment Terraform gives the Container App and its jobs
 * (infra/api.tf), with the platform's drivers (cosmos, azure-blob, table):
 *
 * - `node main.mjs`: the Container App. Serves HTTP on PORT (default 8080) through Front Door:
 *   the API, the UI and the sites hosts (host.ts).
 * - `node main.mjs tick notify` (a job every minute, with mail) and `node main.mjs tick maintain`
 *   (a job every hour): one tick of the core's work, then exit. Safe to repeat or overlap, since
 *   the outbox and the leases are conditional writes in the Table.
 * - `node main.mjs migrate` (a job the deploy starts): the pending data migrations, run until the
 *   runner reports done, then exit; a non-zero exit fails the job's execution.
 *
 * Secrets (SESSION_SECRET, SITE_HMAC_KEY, ORIGIN_VERIFY_SECRET, LIVE_EVENTS_SECRET, the sign-in
 * client secrets) are environment variables Container Apps fills from Key Vault references with
 * the host's identity, so nothing reads Key Vault at start and a rotated secret arrives with the
 * next revision. Every Azure service is reached with that identity (DefaultAzureCredential, which
 * takes AZURE_CLIENT_ID from the environment).
 *
 * Instance values (INSTANCE_NAME, ALLOWED_EMAIL_DOMAINS, BRAND_*, OIDC_*, …) ship in the image as
 * `instance.json` beside the bundle (scripts/build.mjs, from FLING_INSTANCE_CONFIG); the
 * environment wins over the file. The web build sits beside it in `web/`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EmailClient } from '@azure/communication-email'
import { CosmosClient } from '@azure/cosmos'
import { DefaultAzureCredential } from '@azure/identity'
import { BlobServiceClient } from '@azure/storage-blob'
import { WebPubSubServiceClient } from '@azure/web-pubsub'
import { type Config, loadBaseConfig, secretsFromEnv } from '@fling/api/config'
import { MAINTAIN_BUDGET_MS } from '@fling/api/maintenance'
import { MIGRATIONS, runMigrations } from '@fling/api/migrations'
import { drain, maintain } from '@fling/platform-node/ticks'
import { SITE_HMAC_KVS_KEY } from '@fling/shared/route-keys'
import { serve } from '@hono/node-server'
import { AZURE_DRIVERS, buildAzureDeps } from './deps.ts'
import { createAzureHost } from './host.ts'
import { webPubSubConnections } from './live.ts'
import { azureSettings } from './settings.ts'

type Env = Record<string, string | undefined>

const log = (level: 'info' | 'error', msg: string, fields: object = {}) =>
  console.log(JSON.stringify({ level, msg, ...fields }))

/** `instance.json` beside the bundle, if the build wrote one. */
export function instanceFileEnv(url = new URL('./instance.json', import.meta.url)): Env {
  let raw: string
  try {
    raw = readFileSync(url, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('instance.json must be a JSON object')
  }
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]))
}

const env: Env = { ...instanceFileEnv(), ...process.env, ...AZURE_DRIVERS }
const config: Config = { ...loadBaseConfig(env), secrets: secretsFromEnv(env) }
const settings = azureSettings(env, { live: config.live, mail: config.mail?.driver === 'acs' })
const credential = new DefaultAzureCredential()

const cosmos = new CosmosClient({ endpoint: settings.cosmos.endpoint, aadCredentials: credential })
const azure = buildAzureDeps(config, {
  container: cosmos.database(settings.cosmos.database).container(settings.cosmos.container),
  blobService: new BlobServiceClient(settings.blobs.endpoint, credential),
  sitesContainer: settings.blobs.container,
  ...(settings.webPubSub
    ? {
        pubsub: webPubSubConnections(
          new WebPubSubServiceClient(
            settings.webPubSub.endpoint,
            credential,
            settings.webPubSub.hub
          )
        ),
      }
    : {}),
  ...(settings.acsEndpoint ? { email: new EmailClient(settings.acsEndpoint, credential) } : {}),
})
const { deps, table } = azure

/** A job's budget: well inside its replica timeout (infra/api.tf). */
const JOB_BUDGET_MS = 5 * 60_000

/** How many runs `migrate` makes before it gives up, waiting a little when another run is busy. */
const MIGRATE_RUNS = 40

async function migrate() {
  for (let run = 1; ; run++) {
    const report = await runMigrations(table, {
      migrations: MIGRATIONS,
      deadline: Date.now() + JOB_BUDGET_MS,
    })
    log('info', 'migrations', {
      done: report.done,
      data: report.migrations.map(m => `${m.id} ${m.status}`),
    })
    if (report.done) return
    if (run >= MIGRATE_RUNS) throw new Error(`Data migrations still not done after ${run} runs`)
    if (report.migrations.some(m => m.status === 'busy')) {
      await new Promise(resolve => setTimeout(resolve, 20_000))
    }
  }
}

async function main(args: string[]) {
  const [mode, what] = args
  if (mode === 'migrate') return migrate()
  if (mode === 'tick' && what === 'notify') {
    await drain(deps, Date.now() + 50_000)
    return
  }
  if (mode === 'tick' && what === 'maintain') {
    // The container's TTL purges expired items, so there is no purge to run here.
    await maintain(deps, {}, Date.now() + MAINTAIN_BUDGET_MS)
    return
  }
  if (mode !== undefined) throw new Error(`Unknown command: ${args.join(' ')}`)

  // The sites host reads the cookie key from the route table, as every platform's edge does.
  if ((await deps.routeTable.get(SITE_HMAC_KVS_KEY)) !== config.secrets.siteHmacKey) {
    await deps.routeTable.put(SITE_HMAC_KVS_KEY, config.secrets.siteHmacKey)
  }
  const web = (...p: string[]) => fileURLToPath(new URL(`./web/${p.join('/')}`, import.meta.url))
  const host = createAzureHost({
    azure,
    settings,
    uiDir: web('dist'),
    pages: {
      notFound: web('dist-404', '404.html'),
      reviewShell: web('dist-review', 'review-shell.html'),
      robots: web('sites-robots.txt'),
    },
    ...(env.MAX_REQUEST_BYTES ? { maxBodyBytes: Number(env.MAX_REQUEST_BYTES) } : {}),
  })
  const port = Number(env.PORT ?? 8080)
  const server = serve({ fetch: host.fetch, port }, info =>
    log('info', 'fling azure host', {
      port: info.port,
      app: config.appOrigin,
      sites: `*.${config.sitesDomain}`,
    })
  )
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => server.close(() => void host.close().finally(() => process.exit(0))))
  }
}

main(process.argv.slice(2)).then(
  () => {
    if (process.argv[2] !== undefined) process.exit(0)
  },
  err => {
    log('error', 'fling azure failed', { err: String(err) })
    process.exit(1)
  }
)
