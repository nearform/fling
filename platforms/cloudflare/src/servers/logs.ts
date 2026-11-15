/**
 * Site servers' logs in R2: the Cloudflare ServerLogs. Lines arrive from two places, both in the
 * Fling Worker: ServerTail (entrypoints.ts), the tail consumer every server's isolate is loaded
 * with, for what the server printed; and the sites host's shell, for the request line of each
 * invoke. Both go through `later`, which gathers a second's lines in this isolate and writes them
 * as one object, so a busy site costs an R2 write a second per isolate, not two per request.
 *
 * Keys, per site, in time order:
 *   server-logs/<siteId>/<YYYYMMDDHH>/<ms of the first line, 13 digits>-<random>.ndjson   a piece
 *   server-logs/<siteId>/<YYYYMMDDHH>.ndjson                                                the hour's chunk
 * `compact`, from the hourly cron, folds each past hour's pieces into its chunk, whose first line
 * names the pieces it holds (a reader skips any it meets before they are deleted). An R2 lifecycle
 * rule on `server-logs/` (scripts/setup.mjs) deletes objects after SERVER_LOG_DAYS days, and a read
 * never reaches further back than that.
 */
import type { R2Bucket } from '@cloudflare/workers-types'
import type { ServerLogLine, ServerLogs } from '@fling/api/servers/types'
import { SERVER_LOG_DAYS } from '@fling/shared'

export const LOGS_PREFIX = 'server-logs/'
const DAY_MS = 24 * 60 * 60 * 1000
/** How long `later` gathers lines before it writes them. */
const FLUSH_MS = 1000
/** How many objects a read fetches at once. */
const READ_BATCH = 16
/** The longest a printed line is kept. */
const MAX_TEXT = 8 * 1024

const hourOf = (iso: string) => iso.slice(0, 13).replace(/[-T]/g, '')
const hourStart = (hour: string) =>
  Date.UTC(+hour.slice(0, 4), +hour.slice(4, 6) - 1, +hour.slice(6, 8), +hour.slice(8, 10))

/** Where an object's lines start, from its key: a piece's first line, a chunk's hour. */
function startOf(key: string): number {
  const rest = key.split('/').slice(2)
  if (rest.length === 1) return hourStart(rest[0]?.slice(0, 10) ?? '')
  return Number(rest[1]?.slice(0, 13))
}

const isChunk = (key: string) => key.split('/').length === 3

function parseLines(text: string): { merged: string[]; lines: ServerLogLine[] } {
  const merged: string[] = []
  const lines: ServerLogLine[] = []
  for (const raw of text.split('\n')) {
    if (!raw) continue
    try {
      const value = JSON.parse(raw)
      if (Array.isArray(value?.merged)) merged.push(...value.merged)
      else if (typeof value?.at === 'string') lines.push(value as ServerLogLine)
    } catch {}
  }
  return { merged, lines }
}

const byTime = (a: ServerLogLine, b: ServerLogLine) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)

export class R2ServerLogs implements ServerLogs {
  private pending = new Map<string, ServerLogLine[]>()
  private flush: Promise<void> | null = null

  constructor(
    private readonly bucket: R2Bucket,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Write the lines now, as one piece. */
  async append(siteId: string, lines: ServerLogLine[]) {
    if (lines.length === 0) return
    const sorted = [...lines].sort(byTime)
    const first = sorted[0] as ServerLogLine
    const ms = String(Date.parse(first.at)).padStart(13, '0')
    const random = crypto.randomUUID().slice(0, 8)
    const key = `${LOGS_PREFIX}${siteId}/${hourOf(first.at)}/${ms}-${random}.ndjson`
    await this.bucket.put(key, sorted.map(l => JSON.stringify(l)).join('\n'), {
      httpMetadata: { contentType: 'application/x-ndjson' },
    })
  }

  /**
   * The same logs, whose `append` gathers lines for a second and writes them together; the write
   * is kept alive by `waitUntil` (the request's or the tail's), so the caller doesn't wait for it.
   */
  later(waitUntil: (promise: Promise<unknown>) => void): ServerLogs {
    return {
      append: async (siteId, lines) => {
        if (lines.length === 0) return
        const list = this.pending.get(siteId) ?? []
        list.push(...lines)
        this.pending.set(siteId, list)
        this.flush ??= new Promise<void>(resolve => setTimeout(resolve, FLUSH_MS)).then(() => {
          const batch = this.pending
          this.pending = new Map()
          this.flush = null
          return Promise.all(
            [...batch].map(([site, ls]) => this.append(site, ls).catch(() => {}))
          ).then(() => {})
        })
        waitUntil(this.flush)
      },
      read: (siteId, since, limit) => this.read(siteId, since, limit),
    }
  }

  async read(siteId: string, since: Date, limit: number): Promise<ServerLogLine[]> {
    const oldest = this.now().getTime() - SERVER_LOG_DAYS * DAY_MS
    const from = new Date(Math.max(since.getTime(), oldest)).toISOString()
    const prefix = `${LOGS_PREFIX}${siteId}/`
    const merged = new Set<string>()
    let lines: ServerLogLine[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({
        prefix,
        // Every key of `from`'s hour and later sorts after the bare hour.
        ...(cursor ? { cursor } : { startAfter: `${prefix}${hourOf(from)}` }),
      })
      const keys = page.objects.map(o => o.key)
      for (let i = 0; i < keys.length; i += READ_BATCH) {
        const batch = keys.slice(i, i + READ_BATCH).filter(key => !merged.has(key))
        if (lines.length >= limit && batch[0]) {
          // Objects come in the order their lines start: none further on has an earlier one.
          lines.sort(byTime)
          const last = lines[limit - 1] as ServerLogLine
          if (startOf(batch[0]) > Date.parse(last.at)) return lines.slice(0, limit)
        }
        const texts = await Promise.all(
          batch.map(async key => (await this.bucket.get(key))?.text())
        )
        batch.forEach((key, j) => {
          const text = texts[j]
          if (text === undefined || (!isChunk(key) && merged.has(key))) return
          const parsed = parseLines(text)
          for (const m of parsed.merged) merged.add(m)
          lines.push(...parsed.lines.filter(l => l.at >= from))
        })
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    lines = lines.sort(byTime)
    return lines.slice(0, limit)
  }

  /**
   * Fold every past hour's pieces into that hour's chunk, until `deadline`; the rest wait for the
   * next run. Returns how many pieces were folded.
   */
  async compact(deadline: number): Promise<number> {
    const current = hourOf(this.now().toISOString())
    const groups = new Map<string, string[]>()
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix: LOGS_PREFIX, cursor })
      for (const { key } of page.objects) {
        const parts = key.split('/')
        if (parts.length !== 4 || (parts[2] ?? '') >= current) continue
        const chunk = `${parts.slice(0, 3).join('/')}.ndjson`
        const list = groups.get(chunk) ?? []
        list.push(key)
        groups.set(chunk, list)
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor && Date.now() < deadline)
    let folded = 0
    for (const [chunk, pieces] of groups) {
      if (Date.now() >= deadline) break
      const existing = parseLines((await (await this.bucket.get(chunk))?.text()) ?? '')
      const lines = [...existing.lines]
      for (const piece of pieces) {
        lines.push(...parseLines((await (await this.bucket.get(piece))?.text()) ?? '').lines)
      }
      lines.sort(byTime)
      const merged = [...existing.merged, ...pieces]
      const body = [JSON.stringify({ merged }), ...lines.map(l => JSON.stringify(l))].join('\n')
      await this.bucket.put(chunk, body, { httpMetadata: { contentType: 'application/x-ndjson' } })
      for (let i = 0; i < pieces.length; i += 1000) {
        await this.bucket.delete(pieces.slice(i, i + 1000))
      }
      folded += pieces.length
    }
    return folded
  }
}

/** A tail event as the runtime hands it to a tail consumer: the parts that become lines. */
export interface TailEvent {
  logs?: { timestamp: number; level: string; message: unknown[] }[]
  exceptions?: { timestamp: number; name: string; message: string }[]
}

const textOf = (message: unknown[]) =>
  message
    .map(m => {
      if (typeof m === 'string') return m
      try {
        return JSON.stringify(m)
      } catch {
        return String(m)
      }
    })
    .join(' ')
    .slice(0, MAX_TEXT)

/** What a version's server printed, from its tail events, as `output` lines. */
export function tailLines(versionId: string, events: readonly TailEvent[]): ServerLogLine[] {
  const lines: ServerLogLine[] = []
  for (const event of events) {
    for (const log of event.logs ?? []) {
      lines.push({
        at: new Date(log.timestamp).toISOString(),
        versionId,
        kind: 'output',
        level: log.level === 'error' || log.level === 'warn' ? 'error' : 'info',
        text: textOf(log.message),
      })
    }
    for (const ex of event.exceptions ?? []) {
      lines.push({
        at: new Date(ex.timestamp).toISOString(),
        versionId,
        kind: 'output',
        level: 'error',
        text: `Uncaught ${ex.name}: ${ex.message}`.slice(0, MAX_TEXT),
      })
    }
  }
  return lines
}

const logsByBucket = new WeakMap<object, R2ServerLogs>()

/** This isolate's logs over a bucket: one, so `later` gathers every caller's lines together. */
export function serverLogsIn(bucket: R2Bucket): R2ServerLogs {
  let logs = logsByBucket.get(bucket)
  if (!logs) {
    logs = new R2ServerLogs(bucket)
    logsByBucket.set(bucket, logs)
  }
  return logs
}
