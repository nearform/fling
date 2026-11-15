/**
 * Reading a Web Function's CloudWatch events back as server log lines (server-logs.ts
 * `lineOfEvent`), and the Terraform-set plumbing site servers need (servers/index.ts).
 */
import { loadBaseConfig } from '@fling/api/config'
import { describe, expect, it } from 'vitest'
import { requestLogText } from '../src/servers/entry-contract.ts'
import { awsServersSettings } from '../src/servers/index.ts'
import { lineOfEvent } from '../src/servers/server-logs.ts'

const stream = '2026/11/15/acme-site-abc[rev-1]0123'
const versionOf = (rev: string | null) => (rev === 'rev-1' ? 'v1' : undefined)

describe('lineOfEvent', () => {
  it("reads Lambda's JSON events as output lines, naming the revision's version", () => {
    const e = {
      timestamp: Date.parse('2026-11-15T10:00:00.000Z'),
      stream,
      message: JSON.stringify({ timestamp: 'x', level: 'ERROR', message: 'boom\n' }),
    }
    expect(lineOfEvent(e, versionOf)).toEqual({
      at: '2026-11-15T10:00:00.000Z',
      versionId: 'v1',
      kind: 'output',
      level: 'error',
      text: 'boom',
    })
  })

  it("leaves out Lambda's platform events, and keeps a plain line as it is", () => {
    const platform = JSON.stringify({ time: 'x', type: 'platform.initReport', record: {} })
    expect(lineOfEvent({ timestamp: 0, stream, message: platform }, versionOf)).toBeNull()
    expect(lineOfEvent({ timestamp: 0, stream, message: 'plain text' }, versionOf)).toMatchObject({
      kind: 'output',
      level: 'info',
      text: 'plain text',
    })
  })

  it('reads the entry’s request line back as it was written, inside an event or bare', () => {
    const line = {
      at: '2026-11-15T10:00:01.000Z',
      versionId: 'v2',
      kind: 'request' as const,
      method: 'GET',
      path: '/api/x',
      status: 200,
      ms: 12,
      viewer: null,
    }
    const wrapped = JSON.stringify({ timestamp: 'x', level: 'INFO', message: requestLogText(line) })
    expect(lineOfEvent({ timestamp: 0, stream, message: wrapped }, versionOf)).toEqual(line)
    expect(lineOfEvent({ timestamp: 0, stream, message: requestLogText(line) }, versionOf)).toEqual(
      line
    )
  })
})

describe('awsServersSettings', () => {
  const plumbing = {
    SERVER_FUNCTION_PREFIX: 'acme-prod-fling-site-',
    SERVER_INSTANCE: 'acme-prod-fling',
    SERVER_ROLE_ARN: 'arn:aws:iam::123456789012:role/acme-prod-fling-server',
    SERVER_ZIP_BUCKET: 'acme-prod-fling-server-zips',
    SITES_DISTRIBUTION_ARN: 'arn:aws:cloudfront::123456789012:distribution/E1',
  }

  it('is nothing with SERVERS off, whatever the environment', () => {
    expect(awsServersSettings(plumbing, loadBaseConfig({}))).toBeNull()
  })

  it('reads the plumbing with SERVERS on, and names what is missing', () => {
    const config = loadBaseConfig({ SERVERS: 'members' })
    expect(awsServersSettings(plumbing, config)).toMatchObject({
      functionPrefix: 'acme-prod-fling-site-',
      zipBucket: 'acme-prod-fling-server-zips',
      maxSites: 50,
    })
    expect(awsServersSettings(plumbing, config)?.connectorArn).toBeUndefined()
    const { SERVER_ROLE_ARN: _, ...partial } = plumbing
    expect(() => awsServersSettings(partial, config)).toThrow(/SERVER_ROLE_ARN/)
  })
})
