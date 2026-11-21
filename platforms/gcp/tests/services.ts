/**
 * Clients for the local stand-ins the service-backed suites run against: the Firestore emulator
 * and fake-gcs-server. Each suite runs only when its env var is set (CI sets both, with the
 * containers started in ci.yml), so `pnpm gate` passes on a laptop without Docker. To run them
 * locally:
 *
 *   docker run -d -p 8086:8080 gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
 *     gcloud emulators firestore start --host-port=0.0.0.0:8080
 *   docker run -d -p 4443:4443 fsouza/fake-gcs-server -scheme http -port 4443
 *   FLING_TEST_FIRESTORE_EMULATOR_HOST=localhost:8086 \
 *     FLING_TEST_GCS_ENDPOINT=http://localhost:4443 pnpm --filter @fling/platform-gcp test
 *
 * Collections and buckets are named per run here, never in a workflow step.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { Firestore } from '@google-cloud/firestore'
import { Storage } from '@google-cloud/storage'
import { GoogleAuth } from 'google-auth-library'

export const FIRESTORE_EMULATOR_HOST = process.env.FLING_TEST_FIRESTORE_EMULATOR_HOST
export const GCS_ENDPOINT = process.env.FLING_TEST_GCS_ENDPOINT

const projectId = 'fling-test'
const run = randomUUID().slice(0, 8)
let collections = 0
let db: Firestore | undefined

/** The emulator's client (one per run) and a fresh collection on it. */
export function firestoreCollection() {
  db ??= new Firestore({
    projectId,
    host: FIRESTORE_EMULATOR_HOST,
    ssl: false,
    // The emulator takes any credentials; this keeps the client from looking for real ones.
    credentials: { client_email: 'test@fling-test.iam.gserviceaccount.com', private_key: 'x' },
    customHeaders: { Authorization: 'Bearer owner' },
  })
  return { db, collection: `conformance-${run}-${collections++}` }
}

/**
 * A service account key made for this run: the signed URLs are signed with it offline, as a key
 * file would sign them, and the tests' stand-in for Cloud Storage checks them with its public half.
 */
export const SIGNING_KEY = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    client_email: 'fling-test@fling-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
  }
})()

/** A fake-gcs-server client signing with SIGNING_KEY, and a fresh bucket. */
export async function gcsBucket() {
  const auth = new GoogleAuth({
    projectId,
    credentials: { client_email: SIGNING_KEY.client_email, private_key: SIGNING_KEY.private_key },
  })
  // A token that never needs refreshing, so no request ever goes to Google's token endpoint.
  const client = (await auth.getClient()) as { credentials: object }
  client.credentials = { access_token: 'fling-test', expiry_date: Date.now() + 86_400_000 }
  const storage = new Storage({ projectId, apiEndpoint: GCS_ENDPOINT, authClient: auth })
  const bucket = `fling-conformance-${run}`
  const [exists] = await storage.bucket(bucket).exists()
  if (!exists) await storage.createBucket(bucket)
  return { storage, bucket }
}
