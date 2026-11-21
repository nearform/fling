/**
 * The Cloud Run service's process: the GCP host (host.ts) configured from the environment
 * (env.ts), listening on PORT (Cloud Run sets it; default 8080).
 *
 * Its own settings, beside the instance configuration every platform takes:
 * - `FIRESTORE_DATABASE`: the Firestore database (default `(default)`); `TABLE_NAME` is the
 *   collection (default `items`);
 * - `TICK_SERVICE_ACCOUNTS`: comma-separated service accounts whose Google ID tokens may call the
 *   tick and migrate endpoints (Terraform sets the scheduler's and the deploy's);
 * - `WEB_DIR`: the web build, laid out as scripts/build.mjs copies it (default `web/` beside the
 *   bundle; from a checkout, `apps/web`);
 * - `MAX_REQUEST_BYTES`: the largest request body (default 32 MiB, Cloud Run's HTTP/1 limit).
 *
 * The Google clients find their project and credentials themselves: on Cloud Run, the service's
 * own service account from the metadata server.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Firestore } from '@google-cloud/firestore'
import { Storage } from '@google-cloud/storage'
import { GcsBlobs } from './blobs/gcs.ts'
import { type Env, gcpConfig, instanceFileEnv, tickServiceAccounts } from './env.ts'
import { createGcpHost } from './host.ts'
import { FirestoreTable } from './table/firestore.ts'

const env: Env = { ...instanceFileEnv(new URL('./instance.json', import.meta.url)), ...process.env }
const config = gcpConfig(env)
const webDir = resolve(env.WEB_DIR ?? fileURLToPath(new URL('./web/', import.meta.url)))
const web = (...p: string[]) => resolve(webDir, ...p)

const firestore = new Firestore({
  databaseId: env.FIRESTORE_DATABASE?.trim() || '(default)',
})
const table = new FirestoreTable(firestore, {
  ...(config.tableName ? { collection: config.tableName } : {}),
})
const storage = new Storage()
const sitesBucket = config.sitesBucket as string

const gcp = await createGcpHost({
  config,
  table,
  blobs: fallback => new GcsBlobs(sitesBucket, storage, { fallback }),
  tickServiceAccounts: tickServiceAccounts(env),
  web: {
    uiDir: web('dist'),
    pages: {
      notFound: web('dist-404', '404.html'),
      reviewShell: web('dist-review', 'review-shell.html'),
      robots: web('sites-robots.txt'),
    },
  },
  ...(env.MAX_REQUEST_BYTES ? { maxBodyBytes: Number(env.MAX_REQUEST_BYTES) } : {}),
})
const listening = await gcp.host.listen(Number(env.PORT ?? 8080))
console.log(
  JSON.stringify({
    level: 'info',
    msg: 'fling gcp host',
    port: listening.port,
    app: config.appOrigin,
    sites: `*.${config.sitesDomain}`,
    live: config.live,
  })
)

// Cloud Run sends SIGTERM and allows 10 seconds before it stops the instance.
async function shutdown() {
  await listening.close()
  await gcp.close()
  await firestore.terminate()
  process.exit(0)
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown())
