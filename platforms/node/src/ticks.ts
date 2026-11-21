/**
 * The Node host's ticks, whoever calls them: the endpoints (host.ts, for an outside scheduler) and
 * the process's own timers (main.ts). Each is the core's work and is safe to repeat, since the
 * outbox and the leases are conditional writes in the Table.
 *
 * - `notify` (every minute, with mail): drain the notifications outbox.
 * - `maintain` (hourly): the core's maintenance (version retention, replaced home pages, the
 *   revocation sweep), then the Table's expired items purged.
 */
import { maintain as coreMaintain, type MaintainResult } from '@fling/api/maintenance'
import { drain as coreDrain, type DrainResult } from '@fling/api/notifications'
import type { Deps } from '@fling/api/types'

const log = (level: 'info' | 'warn', msg: string, fields: object = {}) =>
  console.log(JSON.stringify({ level, msg, ...fields }))

export async function drain(deps: Deps, deadline?: number): Promise<DrainResult | null> {
  if (!deps.mailer) return null
  try {
    const result = await coreDrain(deps, deadline === undefined ? {} : { deadline })
    log('info', 'notify drain', result)
    return result
  } catch (err) {
    log('warn', 'notify drain failed', { err: String(err) })
    throw err
  }
}

export async function maintain(
  deps: Deps,
  table: { purgeExpired?: () => Promise<number> },
  deadline?: number
): Promise<MaintainResult & { purged: number }> {
  try {
    const result = await coreMaintain(deps, deadline === undefined ? {} : { deadline })
    const purged = (await table.purgeExpired?.()) ?? 0
    log('info', 'maintenance', { ...result, purged })
    return { ...result, purged }
  } catch (err) {
    log('warn', 'maintenance failed', { err: String(err) })
    throw err
  }
}
