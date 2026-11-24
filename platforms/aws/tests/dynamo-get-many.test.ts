/**
 * DynamoTable's `getMany` against a scripted BatchGetItem: what DynamoDB Local never does
 * (leaving keys unprocessed) and what it would refuse (a key twice in one request). The rest of
 * its behaviour is the Table conformance suite on DynamoDB Local (conformance.test.ts).
 */
import { Readable } from 'node:stream'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { describe, expect, it } from 'vitest'
import { DynamoTable } from '../src/table/dynamo.ts'

type Wire = Record<string, { S: string }>
type Request = { RequestItems: Record<string, { Keys: Wire[]; ConsistentRead?: boolean }> }

const TABLE = 't'

/**
 * A client whose BatchGetItem answers from `items` (by sk), leaving unprocessed the keys
 * `unprocess` picks for that round, and records every request.
 */
function scripted(items: string[], unprocess: (round: number, keys: Wire[]) => Wire[] = () => []) {
  const requests: Request[] = []
  // At the HTTP layer, so the document client marshals and unmarshals as it does on the wire.
  const requestHandler = {
    async handle(req: { body: string }) {
      const input = JSON.parse(req.body) as Request
      requests.push(input)
      const keys = input.RequestItems[TABLE]?.Keys ?? []
      const left = unprocess(requests.length - 1, keys)
      const answered = keys.filter(k => !left.includes(k) && items.includes(k.SK?.S ?? ''))
      const output = {
        Responses: { [TABLE]: answered.map(k => ({ ...k, n: { N: '1' } })) },
        ...(left.length ? { UnprocessedKeys: { [TABLE]: { Keys: left } } } : {}),
      }
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/x-amz-json-1.0' },
          body: Readable.from([JSON.stringify(output)]),
        },
      }
    },
  }
  const client = new DynamoDBClient({
    region: 'eu-west-1',
    credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
    requestHandler: requestHandler as never,
  })
  return { table: new DynamoTable(TABLE, client), requests }
}

const sksOf = (r: Request | undefined) => (r?.RequestItems[TABLE]?.Keys ?? []).map(k => k.SK?.S)

describe('DynamoTable getMany', () => {
  it('sends each storable key once, 100 at most a request, strongly consistent', async () => {
    const sks = Array.from({ length: 150 }, (_, i) => `S#${i}`)
    const { table, requests } = scripted(['S#0', 'S#149'])
    const got = await table.getMany([
      ...sks.map(sk => ({ pk: 'P', sk })),
      { pk: 'P', sk: 'S#0' },
      { pk: 'P', sk: 'bad\u0000' },
    ])
    expect(requests.map(r => sksOf(r).length).sort()).toEqual([100, 50])
    expect(requests.every(r => r.RequestItems[TABLE]?.ConsistentRead)).toBe(true)
    expect(requests.flatMap(sksOf).sort()).toEqual([...sks].sort())
    expect(got).toHaveLength(152)
    expect(got[0]).toEqual({ pk: 'P', sk: 'S#0', n: 1 })
    expect(got[149]).toEqual({ pk: 'P', sk: 'S#149', n: 1 })
    expect(got[150]).toEqual(got[0])
    expect(got[150]).not.toBe(got[0])
    expect(got.filter(Boolean)).toHaveLength(3)
    expect(got[151]).toBeNull()
    expect(await table.getMany([{ pk: 'P', sk: 'lone\ud800' }])).toEqual([null])
    expect(requests).toHaveLength(2)
  })

  it('asks again for the keys DynamoDB leaves unprocessed', async () => {
    const { table, requests } = scripted(['A', 'B', 'C'], (round, keys) =>
      round < 2 ? keys.slice(1) : []
    )
    const got = await table.getMany(['A', 'B', 'C'].map(sk => ({ pk: 'P', sk })))
    expect(got.map(i => i?.sk)).toEqual(['A', 'B', 'C'])
    expect(requests.map(sksOf)).toEqual([['A', 'B', 'C'], ['B', 'C'], ['C']])
  })

  it('gives up when round after round gets nothing through', async () => {
    const { table, requests } = scripted(['A'], (_, keys) => keys)
    await expect(table.getMany([{ pk: 'P', sk: 'A' }])).rejects.toThrow(/unprocessed/)
    expect(requests).toHaveLength(8)
  })
})
