/**
 * A site's server from the CLI and the local MCP (the `servers` capability): its site secrets, its
 * log, and the words deploy results use about it. The API routes are servers/api.ts in apps/api;
 * without the capability they answer 404, which reads here as "this Fling doesn't run site
 * servers".
 *
 * Setting or removing a secret redeploys, as `wrangler secret put` does: the live server restarts
 * with the secrets as they now are and is probed again (`live`), and a publish that waited only
 * for secrets goes live once the last is set (`deployed`), or `missing` names those still unset.
 * A secret's value is sent once and never read back.
 */
import {
  type AccessLevel,
  type DeleteSiteSecretResponse,
  DeleteSiteSecretResponseSchema,
  type InstanceMetadata,
  type PutSiteSecretResponse,
  PutSiteSecretResponseSchema,
  type ServerConfig,
  type ServerLogLine,
  ServerLogsResponseSchema,
  type SiteSecretsResponse,
  SiteSecretsResponseSchema,
} from '@fling/shared'
import { type ApiClient, CliApiError } from './api.ts'
import { CliError } from './errors.ts'

/**
 * Whether the instance runs site servers, by its metadata: its `servers` capability. Off unless it
 * says so (an instance from before servers has none). No instance: not known (undefined).
 */
export function serversEnabled(
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined
): boolean | undefined {
  if (!instance) return undefined
  return instance.capabilities.servers === true
}

/** "outbound network: open" or "none", from the `serversEgress` capability. */
export const egressOf = (instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined) =>
  instance?.capabilities.serversEgress === true ? 'open' : 'none'

const WHO: Record<AccessLevel, string> = {
  only_me: 'only you',
  members: 'members only',
  groups: 'named groups only',
  people: 'named people only',
  public: 'public: anyone can call it',
}

/** `server: /api/* · members only · outbound network: open · secrets: SLACK_WEBHOOK_URL` */
export function serverLine(
  level: AccessLevel,
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined,
  config: Pick<ServerConfig, 'secrets'>
): string {
  return [
    'server: /api/*',
    WHO[level],
    `outbound network: ${egressOf(instance)}`,
    `secrets: ${config.secrets.length ? config.secrets.join(', ') : 'none'}`,
  ].join(' · ')
}

/** A 404 from the servers routes on an instance without them; other errors pass through. */
async function serversCall<T>(instanceName: string, site: string, call: () => Promise<T>) {
  try {
    return await call()
  } catch (error) {
    if (error instanceof CliApiError && error.status === 404) {
      throw new CliError(`No site "${site}" with a server that you can manage on ${instanceName}`, {
        hint: `Check the name (\`fling ls\`). Site secrets and logs are for the site's owners and publishers, on a Fling that runs site servers.`,
      })
    }
    throw error
  }
}

const sitePath = (site: string) => `/api/sites/${encodeURIComponent(site)}`

export function listSecrets(
  client: ApiClient,
  site: string,
  instanceName = 'this Fling'
): Promise<SiteSecretsResponse> {
  return serversCall(instanceName, site, () =>
    client.request('GET', `${sitePath(site)}/secrets`, { schema: SiteSecretsResponseSchema })
  )
}

export function setSecret(
  client: ApiClient,
  site: string,
  name: string,
  value: string,
  instanceName = 'this Fling'
): Promise<PutSiteSecretResponse> {
  return serversCall(instanceName, site, () =>
    client.request('PUT', `${sitePath(site)}/secrets/${encodeURIComponent(name)}`, {
      schema: PutSiteSecretResponseSchema,
      body: { value },
    })
  )
}

export function removeSecret(
  client: ApiClient,
  site: string,
  name: string,
  instanceName = 'this Fling'
): Promise<DeleteSiteSecretResponse> {
  return serversCall(instanceName, site, () =>
    client.request('DELETE', `${sitePath(site)}/secrets/${encodeURIComponent(name)}`, {
      schema: DeleteSiteSecretResponseSchema,
    })
  )
}

/** `--since`: `15m`, `1h`, `2d` or an ISO time, as the API takes it. */
export const SINCE_RE = /^\d+[smhd]$/

export function checkSince(since: string): string {
  if (SINCE_RE.test(since) || !Number.isNaN(Date.parse(since))) return since
  throw new CliError(`Invalid --since "${since}"`, {
    hint: 'Use a duration like 15m, 1h or 2d, or a time like 2026-11-15T06:00:00Z.',
  })
}

export async function readLogs(
  client: ApiClient,
  site: string,
  opts: { since?: string; limit?: number } = {},
  instanceName = 'this Fling'
): Promise<ServerLogLine[]> {
  const res = await serversCall(instanceName, site, () =>
    client.request('GET', `${sitePath(site)}/logs`, {
      schema: ServerLogsResponseSchema,
      query: { since: opts.since, limit: opts.limit },
    })
  )
  return res.lines
}

/** A line's identity, to drop the ones a poll from the last line's time returns again. */
export const logLineKey = (line: ServerLogLine) => JSON.stringify(line)

/**
 * The lines of `next` not already seen, oldest first; `seen` is updated. Polling asks again from
 * the newest time seen, so lines at that moment come back once more.
 */
export function newLogLines(seen: Set<string>, next: readonly ServerLogLine[]): ServerLogLine[] {
  const fresh: ServerLogLine[] = []
  for (const line of next) {
    const key = logLineKey(line)
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(line)
  }
  return fresh
}

/** What a set or removed secret did, in lines for the CLI and the MCP (no values, ever). */
export function describeSecretOutcome(
  site: string,
  outcome: Pick<PutSiteSecretResponse, 'live' | 'deployed' | 'missing'>,
  /** a removal: nothing live is not worth saying */
  removed = false
): { lines: string[]; failed: boolean; logs: string[] } {
  const lines: string[] = []
  let failed = false
  let logs: string[] = []
  const { live, deployed, missing } = outcome
  if (live?.ok) lines.push(`The live server (version ${live.versionId}) restarted with it.`)
  else if (live && !live.ok) {
    failed = true
    logs = live.logs
    lines.push(live.message)
  }
  if (deployed && 'url' in deployed) {
    lines.push(`Version ${deployed.versionId} is live now: ${deployed.url}`)
  } else if (deployed) {
    failed = true
    logs = deployed.logs ?? logs
    lines.push(`Version ${deployed.versionId} did not go live: ${deployed.message}`)
    lines.push(
      deployed.error === 'server_failed_to_start'
        ? `It still waits: set or remove a secret (\`fling secrets set ${site} NAME\`) and it is tried again, or fix the server and deploy again (\`fling dev\` runs it locally first).`
        : 'It has stopped waiting for secrets: fix what the message says, then deploy again.'
    )
  }
  if (missing?.length) {
    lines.push(
      `The deploy waiting for secrets still needs ${missing.join(', ')}: set ${missing.length === 1 ? 'it' : 'them'} (\`fling secrets set ${site} NAME\`) and it goes live.`
    )
  }
  if (!removed && !live && !deployed && !missing?.length) {
    lines.push(
      'No version of it is live or waiting for secrets: the next deploy (`fling deploy`) uses it.'
    )
  }
  return { lines, failed, logs }
}

/** The details a site server's refusal carries (api.ts copies them onto the error). */
export function serverErrorOf(error: unknown): {
  code: string
  logs?: string[]
  secrets?: string[]
  imports?: string[]
} | null {
  if (!(error instanceof CliApiError) || !error.code) return null
  const extra = error as unknown as { logs?: unknown; secrets?: unknown; imports?: unknown }
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined
  return {
    code: error.code,
    ...(strings(extra.logs) ? { logs: strings(extra.logs) } : {}),
    ...(strings(extra.secrets) ? { secrets: strings(extra.secrets) } : {}),
    ...(strings(extra.imports) ? { imports: strings(extra.imports) } : {}),
  }
}
