/** Build adapters from config (shared by lambda.ts and dev.ts). */
import type { Config } from './config.ts'
import { CloudFrontKvs } from './kvs/cloudfront.ts'
import { MemoryKvs } from './kvs/memory.ts'
import type { Kvs } from './kvs/types.ts'
import { FsStorage } from './storage/fs.ts'
import { S3Storage } from './storage/s3.ts'
import type { Storage } from './storage/types.ts'
import { DynamoStore } from './store/dynamo.ts'
import { MemoryStore } from './store/memory.ts'
import type { Store } from './store/types.ts'
import { type Deps, systemClock } from './types.ts'

export function buildDeps(
  config: Config,
  opts: { fsRoot?: string; apiBaseUrl?: string; kvs?: Kvs } = {}
): Deps {
  const store: Store =
    config.storeDriver === 'dynamo' ? new DynamoStore(config.tableName ?? '') : new MemoryStore()
  const storage: Storage =
    config.storageDriver === 's3'
      ? new S3Storage(config.sitesBucket ?? '')
      : new FsStorage(
          opts.fsRoot ?? config.fsRoot ?? '.fling-dev',
          opts.apiBaseUrl ?? config.appOrigin,
          config.secrets.sessionSecret
        )
  const kvs: Kvs =
    opts.kvs ??
    (config.kvsDriver === 'cloudfront' ? new CloudFrontKvs(config.kvsArn ?? '') : new MemoryKvs())
  return { config, store, storage, kvs, clock: systemClock }
}
