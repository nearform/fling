/**
 * CloudFrontRouteTable's ETag handling against a stubbed KeyValueStore client: a stale `IfMatch`,
 * however the API names it, refreshes the ETag and retries; any other error is thrown.
 */
import {
  type CloudFrontKeyValueStoreClient,
  ConflictException,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
  ValidationException,
} from '@aws-sdk/client-cloudfront-keyvaluestore'
import { describe, expect, it } from 'vitest'
import { CloudFrontRouteTable } from '../src/route-table/cloudfront.ts'

const $metadata = {}

/** A store at `etag`; each put fails with the next of `failures` (if any), then succeeds. */
function stubStore(failures: Error[]) {
  let etag = 'e1'
  const puts: string[] = []
  const client = {
    send: async (command: unknown) => {
      if (command instanceof DescribeKeyValueStoreCommand) return { ETag: etag }
      if (command instanceof PutKeyCommand) {
        puts.push(command.input.IfMatch ?? '')
        const failure = failures.shift()
        if (failure) throw failure
        etag = `${etag}+`
        return { ETag: etag }
      }
      throw new Error('unexpected command')
    },
  } as unknown as CloudFrontKeyValueStoreClient
  return { client, puts }
}

describe('CloudFrontRouteTable', () => {
  it.each([
    ['ConflictException', () => new ConflictException({ message: 'conflict', $metadata })],
    [
      'ValidationException: Pre-Condition failed',
      () =>
        new ValidationException({
          message: 'Pre-Condition failed during update of Key-Value-Store',
          $metadata,
        }),
    ],
  ])('retries with a fresh ETag after %s', async (_, failure) => {
    const { client, puts } = stubStore([failure()])
    await new CloudFrontRouteTable('arn:kvs', client).put('site', 'v')
    expect(puts).toEqual(['e1', 'e1'])
  })

  it('throws any other ValidationException', async () => {
    const { client } = stubStore([new ValidationException({ message: 'Key too long', $metadata })])
    await expect(new CloudFrontRouteTable('arn:kvs', client).put('site', 'v')).rejects.toThrow(
      'Key too long'
    )
  })
})
