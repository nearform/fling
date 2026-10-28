/**
 * The hub's log lines: JSON, one per line, like the rest of the API. They name batches by id,
 * events by key and recipients by `addressHash` (the first 12 hex characters of the address's
 * sha256), never by address, and never carry a comment body.
 */
import { createHash } from 'node:crypto'

/** A short, stable stand-in for an address in logs. */
export function addressHash(email: string): string {
  return createHash('sha256').update(email).digest('hex').slice(0, 12)
}

export function logNotify(
  level: 'info' | 'warn' | 'error',
  msg: string,
  fields: Record<string, unknown> = {}
) {
  const line = JSON.stringify({ level, msg, ...fields })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/** An error as a log field: its name only, since messages can quote keys with addresses in them. */
export const errorName = (err: unknown) => (err instanceof Error ? err.name : typeof err)
