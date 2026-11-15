/**
 * Site servers' logs on AWS: CloudWatch Logs collects everything a Web Function prints, so there is
 * no `append`. `read` filters the function's home Region log group (`/aws/lambda/web/<fn>`):
 * each event Lambda wrote for the author's output (JSON: `{timestamp, level, message}`) becomes an
 * `output` line, naming the version its revision runs (from the stream's revision id and the
 * revision's label); the request lines the entry printed (entry-contract.ts) come back as they were
 * written; Lambda's own `platform.*` events are left out. Both groups keep SERVER_LOG_DAYS
 * (site-servers.ts sets the retention when it creates the function).
 */
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
  PutRetentionPolicyCommand,
  ResourceAlreadyExistsException,
  ResourceNotFoundException,
} from '@aws-sdk/client-cloudwatch-logs'
import type { ServerLogLine, ServerLogs } from '@fling/api/servers/types'
import { parseRequestLogText } from './entry-contract.ts'
import { functionName, logGroupOf, parseRevisionLabel, revisionOfStream } from './naming.ts'
import type { WebFunctionsApi } from './web-functions.ts'

export interface LogEvent {
  timestamp: number
  message: string
  stream: string
}

/** The CloudWatch Logs calls site servers make. */
export interface LogEventsApi {
  /** A page of a group's events at or after `startTime` (ms), oldest first; none for a missing group. */
  events(
    group: string,
    opts: { startTime: number; limit: number; nextToken?: string }
  ): Promise<{ events: LogEvent[]; nextToken?: string }>
  /** Create the group if it isn't there, and keep its events `days` days. */
  retain(group: string, days: number): Promise<void>
  /** Nothing when it is gone already. */
  deleteGroup(group: string): Promise<void>
  /** The groups whose name starts with `prefix`. */
  groups(prefix: string): Promise<string[]>
}

const missing = (err: unknown) => err instanceof ResourceNotFoundException

export class CloudWatchLogEvents implements LogEventsApi {
  constructor(private readonly client = new CloudWatchLogsClient({})) {}

  async events(group: string, opts: { startTime: number; limit: number; nextToken?: string }) {
    try {
      const res = await this.client.send(
        new FilterLogEventsCommand({
          logGroupName: group,
          startTime: opts.startTime,
          limit: opts.limit,
          nextToken: opts.nextToken,
        })
      )
      return {
        events: (res.events ?? []).map(e => ({
          timestamp: e.timestamp ?? 0,
          message: e.message ?? '',
          stream: e.logStreamName ?? '',
        })),
        ...(res.nextToken ? { nextToken: res.nextToken } : {}),
      }
    } catch (err) {
      if (missing(err)) return { events: [] }
      throw err
    }
  }

  async retain(group: string, days: number) {
    try {
      await this.client.send(new CreateLogGroupCommand({ logGroupName: group }))
    } catch (err) {
      if (!(err instanceof ResourceAlreadyExistsException)) throw err
    }
    await this.client.send(
      new PutRetentionPolicyCommand({ logGroupName: group, retentionInDays: days })
    )
  }

  async deleteGroup(group: string) {
    try {
      await this.client.send(new DeleteLogGroupCommand({ logGroupName: group }))
    } catch (err) {
      if (!missing(err)) throw err
    }
  }

  async groups(prefix: string) {
    const out: string[] = []
    let nextToken: string | undefined
    do {
      const res = await this.client.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix, nextToken })
      )
      for (const g of res.logGroups ?? []) if (g.logGroupName) out.push(g.logGroupName)
      nextToken = res.nextToken
    } while (nextToken)
    return out
  }
}

/**
 * One CloudWatch event as a log line: null for Lambda's own events. `versionOf` maps the stream's
 * revision to the version it runs.
 */
export function lineOfEvent(
  e: LogEvent,
  versionOf: (revisionId: string | null) => string | undefined
): ServerLogLine | null {
  let text = e.message
  let level: 'info' | 'error' = 'info'
  if (text.startsWith('{')) {
    try {
      const o = JSON.parse(text) as { type?: unknown; message?: unknown; level?: unknown }
      if (typeof o.type === 'string' && o.type.startsWith('platform.')) return null
      if (typeof o.message === 'string') {
        text = o.message
        if (typeof o.level === 'string' && /^(error|fatal|warn)/i.test(o.level)) level = 'error'
      }
    } catch {}
  }
  text = text.replace(/\n+$/, '')
  const request = parseRequestLogText(text)
  if (request) return request
  return {
    at: new Date(e.timestamp).toISOString(),
    versionId: versionOf(revisionOfStream(e.stream)) ?? '',
    kind: 'output',
    level,
    text,
  }
}

/** At most this many pages of events per read. */
const MAX_PAGES = 20

export class CloudWatchServerLogs implements ServerLogs {
  constructor(
    private readonly events: LogEventsApi,
    private readonly functions: Pick<WebFunctionsApi, 'listRevisions'>,
    /** the function name prefix (SERVER_FUNCTION_PREFIX) */
    private readonly prefix: string
  ) {}

  async read(siteId: string, since: Date, limit: number): Promise<ServerLogLine[]> {
    const fn = functionName(this.prefix, siteId)
    const events: LogEvent[] = []
    let nextToken: string | undefined
    let pages = 0
    do {
      const page = await this.events.events(logGroupOf(fn), {
        startTime: since.getTime(),
        limit: Math.min(Math.max(limit, 50), 10_000),
        nextToken,
      })
      events.push(...page.events)
      nextToken = page.nextToken
      pages++
    } while (nextToken && events.length < limit && pages < MAX_PAGES)
    if (events.length === 0) return []
    const versions = await this.revisionVersions(fn)
    const lines: ServerLogLine[] = []
    for (const e of events) {
      const line = lineOfEvent(e, rev => (rev ? versions.get(rev) : undefined))
      if (line) lines.push(line)
    }
    const from = since.toISOString()
    return lines
      .filter(l => l.at >= from)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .slice(0, limit)
  }

  /** The first lines a revision printed since `since`: what a failed start probe reports. */
  async revisionOutput(fn: string, revisionId: string, since: Date, max: number) {
    const page = await this.events.events(logGroupOf(fn), {
      startTime: since.getTime(),
      limit: 1000,
    })
    const out: string[] = []
    for (const e of page.events) {
      if (revisionOfStream(e.stream) !== revisionId) continue
      const line = lineOfEvent(e, () => undefined)
      if (line?.kind === 'output' && line.text) out.push(line.text)
      if (out.length >= max) break
    }
    return out
  }

  private async revisionVersions(fn: string) {
    const map = new Map<string, string>()
    for (const r of await this.functions.listRevisions(fn)) {
      const label = parseRevisionLabel(r.description)
      if (label) map.set(r.revisionId, label.versionId)
    }
    return map
  }
}
