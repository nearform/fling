/**
 * CloudFront KeyValueStore via its data-plane API. Writes need the store's current ETag
 * (DescribeKeyValueStore) as `IfMatch`; a concurrent writer makes that stale → ConflictException,
 * so we refresh and retry. The endpoint is global and signed with SigV4A, hence the side-effect
 * import that registers the SigV4A signer.
 */
import '@aws-sdk/signature-v4a'
import {
  CloudFrontKeyValueStoreClient,
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore'
import type { Kvs } from './types.ts'

const MAX_ATTEMPTS = 6

const named = (err: unknown, ...names: string[]) => err instanceof Error && names.includes(err.name)

export class CloudFrontKvs implements Kvs {
  private etag: string | undefined

  constructor(
    private arn: string,
    private client = new CloudFrontKeyValueStoreClient({ region: 'us-east-1' })
  ) {}

  private async currentEtag(refresh = false): Promise<string> {
    if (!this.etag || refresh) {
      const res = await this.client.send(new DescribeKeyValueStoreCommand({ KvsARN: this.arn }))
      this.etag = res.ETag
    }
    if (!this.etag) throw new Error('KeyValueStore returned no ETag')
    return this.etag
  }

  private async write(op: (ifMatch: string) => Promise<{ ETag?: string }>) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await op(await this.currentEtag(attempt > 0))
        this.etag = res.ETag
        return
      } catch (err) {
        if (!named(err, 'ConflictException', 'PreconditionFailed') || attempt >= MAX_ATTEMPTS) {
          throw err
        }
        await new Promise(r => setTimeout(r, 25 * 2 ** attempt + Math.random() * 25))
      }
    }
  }

  async get(key: string) {
    try {
      const res = await this.client.send(new GetKeyCommand({ KvsARN: this.arn, Key: key }))
      return res.Value
    } catch (err) {
      if (named(err, 'ResourceNotFoundException')) return undefined
      throw err
    }
  }

  async put(key: string, value: string) {
    await this.write(IfMatch =>
      this.client.send(new PutKeyCommand({ KvsARN: this.arn, Key: key, Value: value, IfMatch }))
    )
  }

  async delete(key: string) {
    try {
      await this.write(IfMatch =>
        this.client.send(new DeleteKeyCommand({ KvsARN: this.arn, Key: key, IfMatch }))
      )
    } catch (err) {
      if (!named(err, 'ResourceNotFoundException')) throw err
    }
  }
}
