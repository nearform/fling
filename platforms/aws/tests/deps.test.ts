import { FsBlobs } from '@fling/api/blobs/fs'
import { loadBaseConfig } from '@fling/api/config'
import { MemoryRouteTable } from '@fling/api/route-table/memory'
import { Records } from '@fling/api/store/records'
import { describe, expect, it } from 'vitest'
import { S3Blobs } from '../src/blobs/s3.ts'
import { buildAwsDeps } from '../src/deps.ts'
import { ApiGatewayLiveHub, managementEndpoint } from '../src/live.ts'
import { SesMailer } from '../src/mail/ses.ts'
import { CloudFrontRouteTable } from '../src/route-table/cloudfront.ts'

const secrets = {
  sessionSecret: 's'.repeat(40),
  siteHmacKey: 'h'.repeat(40),
}

describe('buildAwsDeps', () => {
  it('production defaults: DynamoDB, S3 and CloudFront KeyValueStore', () => {
    const base = loadBaseConfig({
      APP_ENV: 'production',
      ALLOWED_EMAIL_DOMAINS: 'example.test',
      TABLE_NAME: 'table',
      SITES_BUCKET: 'bucket',
      KVS_ARN: 'arn:aws:cloudfront::123456789012:key-value-store/x',
      OIDC_ISSUER: 'https://idp.example.test',
      OIDC_CLIENT_ID: 'client',
    })
    const { deps, live } = buildAwsDeps({ ...base, secrets: { ...secrets, oidcClientSecret: 'x' } })
    expect(deps.store).toBeInstanceOf(Records)
    expect(deps.blobs).toBeInstanceOf(S3Blobs)
    expect(deps.routeTable).toBeInstanceOf(CloudFrontRouteTable)
    expect(deps.identities?.[0]?.issuer).toBe('https://idp.example.test')
    expect(live).toBeNull()
  })

  it('with LIVE_URL, the API Gateway live hub over the same store', () => {
    const base = loadBaseConfig({
      APP_ENV: 'development',
      LIVE_URL: 'wss://abc.execute-api.eu-west-1.amazonaws.com/live',
    })
    const { deps, live } = buildAwsDeps({ ...base, secrets })
    expect(live).toBeInstanceOf(ApiGatewayLiveHub)
    expect(deps.live).toBe(live)
    expect(managementEndpoint(base.liveUrl ?? '')).toBe(
      'https://abc.execute-api.eu-west-1.amazonaws.com/live'
    )
  })

  it('memory/fs drivers are the core adapters', () => {
    const base = loadBaseConfig({ APP_ENV: 'development', FS_ROOT: '/tmp/fling-deps-test' })
    const { deps } = buildAwsDeps({ ...base, secrets })
    expect(deps.store).toBeInstanceOf(Records)
    expect(deps.blobs).toBeInstanceOf(FsBlobs)
    expect(deps.routeTable).toBeInstanceOf(MemoryRouteTable)
  })

  it('with MAIL_DRIVER=ses, the SES mailer; without a mail driver, none', () => {
    const mail = loadBaseConfig({
      APP_ENV: 'development',
      MAIL_DRIVER: 'ses',
      MAIL_FROM: 'fling@mail.example.test',
      SES_CONFIGURATION_SET: 'fling-mail',
    })
    expect(buildAwsDeps({ ...mail, secrets }).deps.mailer).toBeInstanceOf(SesMailer)
    const none = loadBaseConfig({ APP_ENV: 'development' })
    expect(buildAwsDeps({ ...none, secrets }).deps.mailer).toBeUndefined()
  })
})
