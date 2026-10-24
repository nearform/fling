import { FsBlobs } from '@fling/api/blobs/fs'
import { loadBaseConfig } from '@fling/api/config'
import { MemoryRouteTable } from '@fling/api/route-table/memory'
import { Records } from '@fling/api/store/records'
import { describe, expect, it } from 'vitest'
import { S3Blobs } from '../src/blobs/s3.ts'
import { buildAwsDeps } from '../src/deps.ts'
import { CloudFrontRouteTable } from '../src/route-table/cloudfront.ts'

const secrets = {
  googleClientId: '',
  googleClientSecret: '',
  sessionSecret: 's'.repeat(40),
  siteHmacKey: 'h'.repeat(40),
}

describe('buildAwsDeps', () => {
  it('production defaults: DynamoDB, S3 and CloudFront KeyValueStore', () => {
    const base = loadBaseConfig({
      APP_ENV: 'production',
      TABLE_NAME: 'table',
      SITES_BUCKET: 'bucket',
      KVS_ARN: 'arn:aws:cloudfront::123456789012:key-value-store/x',
    })
    const deps = buildAwsDeps({ ...base, secrets })
    expect(deps.store).toBeInstanceOf(Records)
    expect(deps.blobs).toBeInstanceOf(S3Blobs)
    expect(deps.routeTable).toBeInstanceOf(CloudFrontRouteTable)
  })

  it('memory/fs drivers are the core adapters', () => {
    const base = loadBaseConfig({ APP_ENV: 'development', FS_ROOT: '/tmp/fling-deps-test' })
    const deps = buildAwsDeps({ ...base, secrets })
    expect(deps.store).toBeInstanceOf(Records)
    expect(deps.blobs).toBeInstanceOf(FsBlobs)
    expect(deps.routeTable).toBeInstanceOf(MemoryRouteTable)
  })
})
