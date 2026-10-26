/**
 * The instance the CLI talks to, from its `/.well-known/fling`: fetched (and so checked to be a
 * Fling) by `fling login <url>`, stored in the config, and read from there by every later command
 * and by the local MCP server. A config written before metadata existed (0.2) gets it fetched and
 * stored on first use.
 */
import { type InstanceMetadata, InstanceMetadataSchema, instanceMetadataUrl } from '@fling/shared'
import type { FetchLike } from './api.ts'
import type { ConfigStore, ResolvedConfig } from './config.ts'
import { CliError } from './errors.ts'

/** GET `<server>/.well-known/fling`, validated. Throws a CliError saying what is wrong. */
export async function fetchInstance(
  serverUrl: string,
  fetch: FetchLike
): Promise<InstanceMetadata> {
  const url = instanceMetadataUrl(serverUrl)
  let response: Response
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } })
  } catch (cause) {
    throw new CliError(`Could not reach ${serverUrl} (${(cause as Error).message ?? cause})`, {
      hint: 'Check the address and your connection.',
      cause,
    })
  }
  const notFling = () =>
    new CliError(`${serverUrl} does not look like a Fling server (no valid ${url})`, {
      hint: 'Use the address of your Fling, e.g. https://fling.example.com.',
    })
  if (!response.ok) throw notFling()
  const parsed = InstanceMetadataSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw notFling()
  return parsed.data
}

/**
 * The instance for `config`: the stored copy, else fetched — and stored when `serverUrl` is a
 * remembered server (not a one-off `--server` / FLING_URL address). Null when it can't be had;
 * never throws.
 */
export async function loadInstance(
  store: ConfigStore,
  config: Pick<ResolvedConfig, 'serverUrl' | 'remembered' | 'instance'>,
  fetch: FetchLike
): Promise<InstanceMetadata | null> {
  if (config.instance) return config.instance
  if (!config.serverUrl) return null
  try {
    const instance = await fetchInstance(config.serverUrl, fetch)
    if (config.remembered)
      await store.putServer(config.serverUrl, { instance }, { makeCurrent: false })
    return instance
  } catch {
    return null
  }
}
