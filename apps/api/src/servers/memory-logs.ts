/**
 * Site servers' logs in memory: the core's ServerLogs, for tests and the local runtime. Lines
 * older than SERVER_LOG_DAYS are dropped as new ones come, and at most MAX_LINES are kept per site.
 */
import { SERVER_LOG_DAYS } from '@fling/shared'
import type { ServerLogLine, ServerLogs } from './types.ts'

const MAX_LINES = 10_000
const DAY_MS = 24 * 60 * 60 * 1000

export class MemoryServerLogs implements ServerLogs {
  private readonly sites = new Map<string, ServerLogLine[]>()

  constructor(private readonly now: () => Date = () => new Date()) {}

  async append(siteId: string, lines: ServerLogLine[]) {
    const cutoff = new Date(this.now().getTime() - SERVER_LOG_DAYS * DAY_MS).toISOString()
    const kept = (this.sites.get(siteId) ?? []).filter(l => l.at >= cutoff)
    kept.push(...lines)
    kept.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    this.sites.set(siteId, kept.slice(-MAX_LINES))
  }

  async read(siteId: string, since: Date, limit: number) {
    const from = since.toISOString()
    return (this.sites.get(siteId) ?? []).filter(l => l.at >= from).slice(0, limit)
  }
}
