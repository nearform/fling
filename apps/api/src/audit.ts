/**
 * The audit log: what admins did (impersonations, invitations, revocations) and every invitation
 * someone made by sharing. Each entry is written twice: an AUDIT record, kept AUDIT_TTL_DAYS and
 * listed on the admin page, and a structured log line. The record is written first, so a caller
 * that audits before acting never acts off the record.
 */
import { newSortableId } from './lib/ids.ts'
import type { AuditRecord } from './store/types.ts'
import type { Deps } from './types.ts'

export const AUDIT_TTL_DAYS = 180

/** Write the record and the log line; throws (and nothing else happens) if the record fails. */
export async function audit(
  deps: Pick<Deps, 'store' | 'clock'>,
  entry: Omit<AuditRecord, 'id' | 'at' | 'expiresAt'>
) {
  const now = deps.clock.now()
  const record: AuditRecord = {
    id: newSortableId(now),
    at: now.toISOString(),
    ...entry,
    expiresAt: new Date(now.getTime() + AUDIT_TTL_DAYS * 86_400_000).toISOString(),
  }
  await deps.store.addAuditEntry(record)
  console.info(
    JSON.stringify({
      level: 'info',
      msg: 'audit',
      action: record.action,
      actor: record.actor,
      target: record.target,
      ...(record.until && { until: record.until }),
      ...(record.lapsed && { lapsed: true }),
      ...(record.via && { via: record.via }),
      ...(record.role && { role: record.role }),
    })
  )
}
