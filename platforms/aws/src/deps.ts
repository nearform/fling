/**
 * The AWS adapters for the drivers config selects (DynamoDB, S3, CloudFront KeyValueStore; the
 * production defaults), handed to the core's buildDeps; with live rooms on, the API Gateway
 * WebSocket hub (live.ts) over the same Store. Any other driver is the core's own
 * memory/fs adapter, exactly as before the split.
 */

import type { Config } from '@fling/api/config'
import { buildDeps } from '@fling/api/deps'
import { Records } from '@fling/api/store/records'
import type { Deps } from '@fling/api/types'
import { S3Blobs } from './blobs/s3.ts'
import { ApiGatewayLiveHub, apiGatewayConnections, type Connections } from './live.ts'
import { CloudFrontRouteTable } from './route-table/cloudfront.ts'
import { DynamoTable } from './table/dynamo.ts'

export function buildAwsDeps(
  config: Config,
  opts: { connections?: Connections } = {}
): { deps: Deps; live: ApiGatewayLiveHub | null } {
  const store =
    config.storeDriver === 'dynamo'
      ? new Records(new DynamoTable(config.tableName ?? ''))
      : undefined
  const deps = buildDeps(config, {
    store,
    blobs: config.storageDriver === 's3' ? new S3Blobs(config.sitesBucket ?? '') : undefined,
    routeTable:
      config.kvsDriver === 'cloudfront' ? new CloudFrontRouteTable(config.kvsArn ?? '') : undefined,
  })
  if (!config.live || !config.liveUrl) return { deps, live: null }
  const live = new ApiGatewayLiveHub(
    deps.store,
    opts.connections ?? apiGatewayConnections(config.liveUrl)
  )
  return { deps: { ...deps, live }, live }
}
