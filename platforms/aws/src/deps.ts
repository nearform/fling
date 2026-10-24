/**
 * The AWS adapters for the drivers config selects (DynamoDB, S3, CloudFront KeyValueStore; the
 * production defaults), handed to the core's buildDeps. Any other driver is the core's own
 * memory/fs adapter, exactly as before the split.
 */

import type { Config } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import type { Deps } from '@fling/api/types'
import { S3Blobs } from './blobs/s3.ts'
import { CloudFrontRouteTable } from './route-table/cloudfront.ts'
import { DynamoStore } from './store/dynamo.ts'

export function buildAwsDeps(config: Config): Deps {
  return buildDeps(config, {
    store: config.storeDriver === 'dynamo' ? new DynamoStore(config.tableName ?? '') : undefined,
    blobs: config.storageDriver === 's3' ? new S3Blobs(config.sitesBucket ?? '') : undefined,
    routeTable:
      config.kvsDriver === 'cloudfront' ? new CloudFrontRouteTable(config.kvsArn ?? '') : undefined,
  })
}
