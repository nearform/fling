/**
 * An S3Blobs from the environment, for a host that runs anywhere (the Node host, platforms/node):
 *
 * | Name | Default | What |
 * |---|---|---|
 * | `SITES_BUCKET` | (required) | the bucket |
 * | `S3_ENDPOINT` | AWS S3 | the store's API as the host reaches it (`https://nyc3.digitaloceanspaces.com`, `http://minio:9000`) |
 * | `S3_PUBLIC_ENDPOINT` | `S3_ENDPOINT` | the store as clients reach it: the address presigned URLs name |
 * | `S3_REGION` | `AWS_REGION`, else `us-east-1` | the region the requests are signed for (Spaces: the datacentre, `nyc3`) |
 * | `S3_FORCE_PATH_STYLE` | off | `<endpoint>/<bucket>/<key>` URLs instead of `<bucket>.<endpoint>/<key>` (MinIO needs it) |
 * | `S3_UPLOAD_DIGEST` | `md5` with an endpoint, `sha256` without | what a presigned PUT binds (S3Blobs' `digest`) |
 * | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (secrets) | the SDK's default chain | the store's keys |
 *
 * `md5` is the default for any endpoint because every S3-compatible store checks `Content-MD5`;
 * `sha256` only where the store is known to reject a body whose `x-amz-checksum-sha256` differs
 * (AWS S3, MinIO). With `md5`, a file whose MD5 the client did not send is uploaded through
 * `fallback` (the core's HostUploads on the host).
 */
import { S3Client } from '@aws-sdk/client-s3'
import type { Blobs } from '@fling/api/blobs'
import { S3_CLIENT_CONFIG, S3Blobs, type S3Digest } from './blobs.ts'

export type S3Env = Record<string, string | undefined>

export interface S3Settings {
  bucket: string
  endpoint?: string
  publicEndpoint?: string
  region: string
  forcePathStyle: boolean
  digest: S3Digest
  credentials?: { accessKeyId: string; secretAccessKey: string }
}

const value = (env: S3Env, name: string) => env[name]?.trim() || undefined

function url(env: S3Env, name: string): string | undefined {
  const raw = value(env, name)
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return raw.replace(/\/$/, '')
  } catch {
    // reported below
  }
  throw new Error(`${name} must be an http(s) URL`)
}

/** The settings `s3FromEnv` uses, checked: it throws naming the variable that is wrong. */
export function s3Settings(env: S3Env): S3Settings {
  const bucket = value(env, 'SITES_BUCKET')
  if (!bucket) throw new Error('SITES_BUCKET is required with STORAGE_DRIVER=s3')
  const endpoint = url(env, 'S3_ENDPOINT')
  const publicEndpoint = url(env, 'S3_PUBLIC_ENDPOINT')
  const digest = value(env, 'S3_UPLOAD_DIGEST') ?? (endpoint ? 'md5' : 'sha256')
  if (digest !== 'md5' && digest !== 'sha256') {
    throw new Error('S3_UPLOAD_DIGEST must be md5 or sha256')
  }
  const pathStyle = (value(env, 'S3_FORCE_PATH_STYLE') ?? 'false').toLowerCase()
  if (!['true', 'false', '1', '0', 'on', 'off', 'yes', 'no'].includes(pathStyle)) {
    throw new Error('S3_FORCE_PATH_STYLE must be true or false')
  }
  const accessKeyId = value(env, 'S3_ACCESS_KEY_ID')
  const secretAccessKey = value(env, 'S3_SECRET_ACCESS_KEY')
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are set together')
  }
  return {
    bucket,
    ...(endpoint ? { endpoint } : {}),
    ...(publicEndpoint ? { publicEndpoint } : {}),
    region: value(env, 'S3_REGION') ?? value(env, 'AWS_REGION') ?? 'us-east-1',
    forcePathStyle: ['true', '1', 'on', 'yes'].includes(pathStyle),
    digest,
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  }
}

function client(settings: S3Settings, endpoint: string | undefined): S3Client {
  return new S3Client({
    ...S3_CLIENT_CONFIG,
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    ...(endpoint ? { endpoint } : {}),
    ...(settings.credentials ? { credentials: settings.credentials } : {}),
  })
}

/** S3Blobs on the store the environment names (see the header). */
export function s3FromEnv(
  env: S3Env,
  opts: { fallback?: Pick<Blobs, 'presignPut'> } = {}
): S3Blobs {
  const settings = s3Settings(env)
  const presigner =
    settings.publicEndpoint && settings.publicEndpoint !== settings.endpoint
      ? client(settings, settings.publicEndpoint)
      : undefined
  return new S3Blobs(settings.bucket, client(settings, settings.endpoint), {
    digest: settings.digest,
    ...(opts.fallback ? { fallback: opts.fallback } : {}),
    ...(presigner ? { presigner } : {}),
  })
}
