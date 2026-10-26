/**
 * Which Fling a local MCP tool call goes to, and how the server describes the Flings it knows.
 *
 * The local MCP server knows every Fling the CLI remembers (`~/.fling/config.json`). A call picks
 * one with its `server` argument (an address, host or unique parent domain, matched with
 * `matchServer` against the remembered ones). Without it:
 * - with `fling mcp --server` or `FLING_URL` set, the call goes there (the server is pinned);
 * - with one remembered Fling (or none), the call goes to it, as the CLI would;
 * - with several, the call does not run: it answers with the list, so the model settles with the
 *   user which Fling the conversation uses and passes it on every call. The current Fling
 *   (`fling use`) is only suggested, never used silently.
 *
 * On start, the server remembers the Fling the extension was downloaded from (`FLING_ADD_SERVER`),
 * best effort, without touching an existing entry and making it current only when none is.
 * Descriptions are written at start from the Flings known then; `fling_servers` lists them live.
 */
import type { InstanceMetadata } from '@fling/shared'
import type { FetchLike } from './api.ts'
import {
  type CliConfig,
  type ConfigStore,
  matchServer,
  normalizeServerUrl,
  type ResolvedConfig,
} from './config.ts'
import { CliError } from './errors.ts'
import { fetchInstance } from './instance.ts'

/** A Fling the MCP server knows, as its descriptions and `fling_servers` show it. */
export interface KnownServer {
  url: string
  instance?: InstanceMetadata | null
  /** The CLI's current server (`fling use`): the user's usual one. */
  current: boolean
  signedIn: boolean
  email?: string
}

/** How a server is shown to the model: its host (instance names can be the same). */
export function serverLabel(url: string): string {
  const u = new URL(url)
  return `${u.host}${u.pathname}`.replace(/\/+$/, '')
}

/** `fling.example.com (Example Fling; signed in as ada@example.com; current)` */
export function describeServer(s: KnownServer): string {
  const facts = [
    s.instance?.name,
    s.signedIn ? (s.email ? `signed in as ${s.email}` : 'signed in') : 'signed out',
    s.current ? "current: the user's usual one" : undefined,
  ].filter(Boolean)
  return `${serverLabel(s.url)} (${facts.join('; ')})`
}

/** The remembered servers, from a loaded config. */
export function knownServersOf(config: CliConfig): KnownServer[] {
  return Object.entries(config.servers).map(([url, entry]) => ({
    url,
    instance: entry.instance,
    current: url === config.current,
    signedIn: Boolean(entry.apiKey),
    ...(entry.apiKey && entry.user?.email ? { email: entry.user.email } : {}),
  }))
}

const listing = (servers: readonly KnownServer[]) =>
  servers.map(s => `- ${describeServer(s)}`).join('\n')

/** A call that needs `server`: answered (not failed) with the list, so the model can ask. */
export class ServerNeededError extends CliError {
  readonly servers: KnownServer[]
  constructor(servers: KnownServer[], tool: string) {
    super(
      `Not run: several Flings are set up on this computer, so ${tool} needs \`server\`.\n${listing(servers)}\n` +
        'Unless the conversation already says which Fling to use, ask the user (suggest their usual one, marked ' +
        `current). Then call ${tool} again with \`server\` (e.g. "${serverLabel(servers[0]?.url ?? 'https://fling.example.com')}"), ` +
        'and pass the same `server` on every call for the rest of the conversation.'
    )
    this.name = 'ServerNeededError'
    this.servers = servers
  }
}

/**
 * The remembered server `input` names. Throws a CliError listing the remembered servers when it
 * names none of them, or several.
 */
export function rememberedServer(config: CliConfig, input: string): string {
  const servers = knownServersOf(config)
  const known = servers.length
    ? `The Flings set up on this computer:\n${listing(servers)}`
    : 'No Fling is set up on this computer yet.'
  let match: { url: string; remembered: boolean }
  try {
    match = matchServer(Object.keys(config.servers), input, { loose: true })
  } catch (error) {
    throw new CliError((error as Error).message, { hint: known })
  }
  if (!match.remembered)
    throw new CliError(`"${input}" is not a Fling set up on this computer`, {
      hint: `${known}\nTo add one, call fling_login with its address as \`server\`.`,
    })
  return match.url
}

/** Whether `fling mcp --server` or `FLING_URL` pins the server calls go to by default. */
export const isPinned = (config: Pick<ResolvedConfig, 'serverUrlSource'>) =>
  config.serverUrlSource === 'flag' || config.serverUrlSource === 'env'

/** Settle `promise` within `ms`, else `fallback`; never throws. */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>(r => {
    timer = setTimeout(() => r(fallback), ms)
  })
  try {
    return await Promise.race([promise.catch(() => fallback), late])
  } finally {
    clearTimeout(timer)
  }
}

/** How long start-up waits for a server's `/.well-known/fling`. */
const START_FETCH_MS = 5_000

/**
 * Remember `address` (a Fling the extension was downloaded from) if it is new: its metadata is
 * fetched best effort, and it becomes current only when no server is. A known one is left as is.
 */
export async function addServerOnStart(
  store: ConfigStore,
  address: string | undefined,
  fetch: FetchLike
): Promise<void> {
  if (!address) return
  let url: string
  try {
    url = normalizeServerUrl(address)
  } catch {
    return
  }
  if (url in (await store.load()).servers) return
  const instance = await within(fetchInstance(url, fetch), START_FETCH_MS, null)
  await store.putServer(url, instance ? { instance } : {})
}

/**
 * The Flings the descriptions name, read at start: the pinned one alone, else every remembered
 * one. Missing metadata is fetched best effort (and stored).
 */
export async function knownServers(
  store: ConfigStore,
  fetch: FetchLike,
  pin?: string
): Promise<KnownServer[]> {
  const resolved = await store.resolve({ serverUrl: pin })
  const config = await store.load()
  const all = knownServersOf(config)
  const servers = isPinned(resolved)
    ? resolved.serverUrl
      ? [
          all.find(s => s.url === resolved.serverUrl) ?? {
            url: resolved.serverUrl,
            current: false,
            signedIn: Boolean(resolved.apiKey),
          },
        ]
      : []
    : all
  return Promise.all(
    servers.map(async s => {
      if (s.instance) return s
      const instance = await within(fetchInstance(s.url, fetch), START_FETCH_MS, null)
      if (instance && s.url in config.servers)
        await store.putServer(s.url, { instance }, { makeCurrent: false }).catch(() => {})
      return { ...s, instance }
    })
  )
}

// --- wording ------------------------------------------------------------------------------------

/** The `server` argument's description. */
export function serverArgDescription(servers: readonly KnownServer[]): string {
  const [only] = servers
  if (servers.length > 1)
    return (
      `Which Fling: ${servers.map(s => serverLabel(s.url)).join(', ')} (an address, host or unique part of it). ` +
      'Required while several Flings are set up: the one settled on for this conversation, on every call'
    )
  return `Which Fling, by address or host (any set up on this computer; see fling_servers). Omit it to use ${only ? serverLabel(only.url) : 'the one this computer is signed in to'}`
}

/** Appended to a server tool's description when several Flings are known. */
export function serverToolNote(servers: readonly KnownServer[]): string {
  if (servers.length < 2) return ''
  return ` Pass \`server\`: several Flings are set up (${servers.map(s => serverLabel(s.url)).join(', ')}), and every call names the one settled on for this conversation.`
}

/** The instructions' paragraph on choosing a Fling, when several are known. */
export function serversInstructions(servers: readonly KnownServer[]): string | undefined {
  if (servers.length < 2) return undefined
  const usual = servers.find(s => s.current)
  return [
    `Several Flings are set up on this computer:\n${listing(servers)}`,
    "Settle which one this conversation uses before anything else: from the user's words " +
      `("on ${serverLabel(servers[0]?.url ?? '')}", "on the ${servers[0]?.instance?.name ?? 'other'} one") or, if they don't say, by asking them` +
      `${usual ? ` (suggest ${serverLabel(usual.url)}, their usual one)` : ''}. ` +
      'Say which Fling you are using, and pass it as `server` on every call for the rest of the conversation; ' +
      'switch only when the user asks. Calls without `server` do not run while several Flings are set up. ' +
      'Each Fling has its own sites, sign-in and sites domain: give the user the links that come back, which name the Fling.',
    'This list was read when this server started and may have changed: call fling_servers to see the Flings ' +
      'set up now. To sign in to a Fling, or add one, call fling_login with its address as `server`.',
  ].join('\n\n')
}
