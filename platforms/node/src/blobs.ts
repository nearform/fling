/**
 * The Node host's object store, chosen by `STORAGE_DRIVER`:
 *
 * - `fs` (the default): the core's FsBlobs under `FS_ROOT`, its signed routes on the app host. One
 *   machine, or a volume every process mounts.
 * - `s3`: S3Blobs (@fling/platform-s3) on any S3-compatible store, configured from the
 *   environment (`SITES_BUCKET`, `S3_*`; platforms/s3/src/env.ts). A store bound by MD5 sends a
 *   file whose MD5 the client did not send through the host's upload routes (HostUploads, signed
 *   with the session secret on the app origin), which the host then serves (`uploads`).
 */

import type { Blobs } from '@fling/api/blobs'
import { FsBlobs } from '@fling/api/blobs/fs'
import { HostUploads } from '@fling/api/blobs/host-uploads'
import type { Config } from '@fling/api/config'
import { type S3Env, s3FromEnv } from '@fling/platform-s3/env'

export type StorageDriver = 'fs' | 's3'

/** The driver `STORAGE_DRIVER` names (default `fs`); any other is refused. */
export function storageDriver(env: S3Env): StorageDriver {
  const driver = env.STORAGE_DRIVER?.trim() || 'fs'
  if (driver !== 'fs' && driver !== 's3') {
    throw new Error(`STORAGE_DRIVER must be fs or s3 on the Node host (got ${driver})`)
  }
  return driver
}

export interface NodeBlobs {
  blobs: Blobs
  /** the host's upload and download routes, for a store that can't bind every upload itself */
  uploads?: HostUploads
}

export function nodeBlobs(config: Config, env: S3Env, fsRoot: string): NodeBlobs {
  if (storageDriver(env) === 'fs') {
    return { blobs: new FsBlobs(fsRoot, config.appOrigin, config.secrets.sessionSecret) }
  }
  const uploads = new HostUploads(s3FromEnv(env), {
    secret: config.secrets.sessionSecret,
    baseUrl: config.appOrigin,
  })
  const blobs = s3FromEnv(env, { fallback: uploads })
  return blobs.uploadDigest === 'md5' ? { blobs, uploads } : { blobs }
}
