/**
 * What the site page shows of a site server (`servers` capability): its limits as labelled rows,
 * the site secrets beside the names the live version (and a publish waiting for secrets) needs,
 * what setting or removing one did, request counts from the server's log, and an admin's limit
 * input read back as the API takes it.
 */
import type {
  DeleteSiteSecretResponse,
  PutSiteSecretResponse,
  ServerLimits,
  ServerLogLine,
  SiteDetail,
  SiteSecret,
  SiteSecretsResponse,
} from '@fling/shared'
import { formatBytes, shortVersion } from './format'

/** How often the Logs panel asks for new lines while it follows the log. */
export const LOGS_FOLLOW_MS = 2000

/** The log the Logs panel and the request counts read: the last hour. */
export const LOGS_SINCE = '1h'

export type LimitKey = keyof ServerLimits

/** Each limit, in the order the site page lists them, with what it is and how it reads. */
export const LIMITS: readonly {
  key: LimitKey
  label: string
  /** the unit an admin types the value in */
  unit: string
  /** where only some platforms enforce it */
  note?: string
  format: (value: number) => string
}[] = [
  {
    key: 'timeoutSeconds',
    label: 'Time per request',
    unit: 'seconds',
    format: v => `${v} s`,
  },
  {
    key: 'cpuMs',
    label: 'CPU per request',
    unit: 'milliseconds',
    note: 'where the platform measures it',
    format: v => (v >= 1000 && v % 1000 === 0 ? `${v / 1000} s` : `${v} ms`),
  },
  {
    key: 'rps',
    label: 'Requests a second',
    unit: 'requests',
    format: v => String(v),
  },
  {
    key: 'environments',
    label: 'Environments at once',
    unit: 'environments',
    note: 'where the platform has them',
    format: v => String(v),
  },
  {
    key: 'bodyBytes',
    label: 'Request body',
    unit: 'bytes',
    format: v => formatBytes(v),
  },
]

/**
 * One site secret as the Secrets section lists it: set or not, and whether the live version
 * declares it, or the publish waiting for secrets needs it.
 */
export interface SecretRow {
  name: string
  set: SiteSecret | null
  declared: boolean
  /** needed by the version waiting for secrets */
  waiting: boolean
}

export type AwaitingSecrets = NonNullable<SiteDetail['awaitingSecrets']>

/**
 * The secrets to list: those the live version declares first, in its order (set or missing), then
 * those the waiting publish still needs, then those set that neither uses (kept for a rollback),
 * by name.
 */
export function secretRows(res: SiteSecretsResponse, awaiting?: AwaitingSecrets): SecretRow[] {
  const byName = new Map(res.secrets.map(s => [s.name, s]))
  const declared = new Set(res.declared)
  const needed = new Set(awaiting?.secrets ?? [])
  const waiting = [...needed].filter(n => !declared.has(n))
  const listed = new Set([...declared, ...waiting])
  return [
    ...res.declared.map(name => ({
      name,
      set: byName.get(name) ?? null,
      declared: true,
      waiting: needed.has(name),
    })),
    ...waiting.map(name => ({
      name,
      set: byName.get(name) ?? null,
      declared: false,
      waiting: true,
    })),
    ...res.secrets
      .filter(s => !listed.has(s.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(s => ({ name: s.name, set: s, declared: false, waiting: false })),
  ]
}

/** The secrets the waiting publish still needs: those it was missing that aren't set since. */
export function stillAwaited(res: SiteSecretsResponse, awaiting: AwaitingSecrets): string[] {
  const set = new Set(res.secrets.map(s => s.name))
  return awaiting.secrets.filter(n => !set.has(n))
}

/** What setting or removing a secret did, as the Secrets section says it. */
export interface SecretOutcome {
  tone: 'success' | 'warning' | 'error'
  text: string
  /** a version that went live: its site address */
  url?: string
  /** the server's log, when it failed to start */
  logs?: string[]
}

/**
 * What a secret change did: the publish that waited went live (or was refused), or still waits
 * for some; the live server started with the change (or didn't, and still serves with it).
 */
export function secretOutcome(
  change: 'set' | 'removed',
  result: PutSiteSecretResponse | DeleteSiteSecretResponse
): SecretOutcome {
  const name = result.name
  if ('deployed' in result && result.deployed) {
    const d = result.deployed
    if ('url' in d) {
      return {
        tone: 'success',
        text: `Version ${shortVersion(d.versionId)} is now live.`,
        url: d.url,
      }
    }
    return {
      tone: 'error',
      text: `Version ${shortVersion(d.versionId)} didn’t go live: ${d.message}`,
      ...(d.logs?.length ? { logs: d.logs } : {}),
    }
  }
  if ('missing' in result && result.missing?.length) {
    return {
      tone: 'warning',
      text: `${name} is set. The waiting version still needs ${result.missing.join(', ')} before it can go live.`,
    }
  }
  if (result.live) {
    const live = result.live
    if (live.ok) {
      return {
        tone: 'success',
        text:
          change === 'set'
            ? `${name} is set: the live server runs with the new value.`
            : `${name} is removed: the live server runs without it.`,
      }
    }
    return {
      tone: 'error',
      text: `${name} is ${change}, but the live server didn’t start with it: ${live.message}`,
      ...(live.logs.length ? { logs: live.logs } : {}),
    }
  }
  return {
    tone: 'success',
    text: change === 'set' ? `${name} is set.` : `${name} is removed.`,
  }
}

/** The requests in a log, and how many of them the server answered with a 5xx. */
export function requestCounts(lines: readonly ServerLogLine[]): {
  requests: number
  errors: number
} {
  let requests = 0
  let errors = 0
  for (const line of lines) {
    if (line.kind !== 'request') continue
    requests++
    if ((line.status ?? 0) >= 500) errors++
  }
  return { requests, errors }
}

/**
 * An admin's limit as typed: blank puts it back to the instance's (null), a whole number above
 * zero sets it, anything else is not a limit (undefined).
 */
export function parseLimit(text: string): number | null | undefined {
  const value = text.trim()
  if (value === '') return null
  if (!/^\d+$/.test(value)) return undefined
  const n = Number(value)
  return n > 0 ? n : undefined
}

/** `12:04:31`: a log line's time of day, in the reader's time zone. */
export function logTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString('en-GB', { hour12: false })
}
