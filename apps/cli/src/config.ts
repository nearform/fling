/**
 * CLI config: `~/.fling/config.json` (dir 0700, file 0600) remembering every Fling server signed in
 * to, keyed by its normalised address, and which one is current:
 *
 *   { "current": "https://fling.example.com",
 *     "servers": { "https://fling.example.com": { "instance": {…}, "apiKey": "…", "user": {…} } } }
 *
 * Each entry holds what the server said about itself at login (`/.well-known/fling`), its API key
 * and the signed-in user. There is no default server: `fling login <url>` adds one and makes it
 * current, `fling use <url>` switches. A single-server file (`serverUrl`, `instance`, `apiKey` and
 * `user` at the top level, written by 0.3) reads as one entry, which is current; the next save
 * writes the shape above. Entries it cannot read are left out, never fatal.
 *
 * Env overrides (for CI): `FLING_URL` picks a server for one run (a remembered one brings its key),
 * `FLING_API_KEY` overrides the key, `FLING_CONFIG_DIR` relocates the directory. `FLING_DEBUG`
 * enables debug lines. `FLING_ADD_SERVER` (the Claude Desktop extension a Fling serves sets it to
 * that Fling's address) is a server for the local MCP server to remember when it starts. This is the
 * only module that reads `process.env`.
 */
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type InstanceMetadata, InstanceMetadataSchema } from '@fling/shared'
import { z } from 'zod'
import { CliError } from './errors.ts'

export const CONFIG_DIR_NAME = '.fling'
export const CONFIG_FILE_NAME = 'config.json'

export const ENV = {
  apiKey: 'FLING_API_KEY',
  url: 'FLING_URL',
  configDir: 'FLING_CONFIG_DIR',
  debug: 'FLING_DEBUG',
  /** Where to look for files given by name (the .mcpb extension sets it from its settings). */
  downloadsDir: 'FLING_DOWNLOADS_DIR',
  /** A server the local MCP server adds to the remembered ones on start (the .mcpb bakes it in). */
  addServer: 'FLING_ADD_SERVER',
} as const

/** One remembered server. Each field is read on its own: one this CLI can't read is dropped. */
export const serverEntrySchema = z.object({
  /** What the server said about itself at login. A copy this CLI can't read is just refetched. */
  instance: InstanceMetadataSchema.optional().catch(undefined),
  apiKey: z.string().min(1).optional().catch(undefined),
  user: z
    .object({
      email: z.string().optional(),
      name: z.string().optional(),
      userSlug: z.string().optional(),
    })
    .optional()
    .catch(undefined),
})
export type ServerEntry = z.infer<typeof serverEntrySchema>

export interface CliConfig {
  /** The server commands use unless `--server` or `FLING_URL` picks another. */
  current?: string
  /** Keyed by normalised server address (`normalizeServerUrl`). */
  servers: Record<string, ServerEntry>
}

export type Env = Record<string, string | undefined>

/** The real machine, for looking files up by name (locate.ts). */
export function systemLocateOptions(env: Env = process.env) {
  return { cwd: process.cwd(), home: homedir(), platform: process.platform, env }
}

/** An env value, ignoring blanks and unsubstituted `${user_config.…}` placeholders (.mcpb). */
function fromEnv(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v && !v.startsWith('${') ? v : undefined
}

/** The server `FLING_ADD_SERVER` names, if any (an unsubstituted placeholder counts as none). */
export function serverToAdd(env: Env = process.env): string | undefined {
  return fromEnv(env[ENV.addServer])
}

export function resolveConfigDir(env: Env = process.env): string {
  return env[ENV.configDir] ?? join(env.HOME ?? homedir(), CONFIG_DIR_NAME)
}

export interface ResolvedConfig {
  /** Unset until `fling login <url>` (or FLING_URL / --server). */
  serverUrl?: string
  serverUrlSource: 'flag' | 'env' | 'config' | 'none'
  /** The current server; `serverUrl` differs from it when `--server` or FLING_URL picks another. */
  current?: string
  /** Whether `serverUrl` has an entry in the config. */
  remembered: boolean
  /** The stored metadata of `serverUrl`. */
  instance?: InstanceMetadata
  apiKey?: string
  apiKeySource: 'env' | 'config' | 'none'
  user?: ServerEntry['user']
  debug: boolean
}

export interface ConfigStore {
  readonly dir: string
  readonly file: string
  load(): Promise<CliConfig>
  save(config: CliConfig): Promise<void>
  /**
   * Add a server, or merge `patch` into its entry. It becomes current when `makeCurrent` says so
   * or, by default, when no server is current.
   */
  putServer(
    serverUrl: string,
    patch: ServerEntry,
    options?: { makeCurrent?: boolean }
  ): Promise<CliConfig>
  /** Make a server current (with an empty entry if it has none). */
  setCurrent(serverUrl: string): Promise<void>
  /** Remove a server's key and user; keep the server and its instance. */
  clearCredentials(serverUrl: string): Promise<void>
  /** Forget a server. Forgetting the current one leaves no server current. */
  removeServer(serverUrl: string): Promise<void>
  /** Merge file + env + an optional `--server` flag into what a command should use. */
  resolve(overrides?: { serverUrl?: string }): Promise<ResolvedConfig>
}

function safeNormalize(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  try {
    return normalizeServerUrl(input)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A config file's JSON, in either shape. Throws only when it is not a JSON object. */
export function parseConfig(json: unknown): CliConfig {
  if (!isObject(json)) throw new Error('expected a JSON object')
  const servers: Record<string, ServerEntry> = {}
  let current: string | undefined
  if ('servers' in json) {
    if (isObject(json.servers)) {
      for (const [key, value] of Object.entries(json.servers)) {
        const url = safeNormalize(key)
        const entry = isObject(value) ? serverEntrySchema.safeParse(value) : undefined
        if (url && entry?.success) servers[url] = { ...servers[url], ...entry.data }
      }
    }
    current = safeNormalize(json.current)
  } else {
    // The single-server shape: its server is the one entry, and current.
    current = safeNormalize(json.serverUrl)
    if (current) servers[current] = serverEntrySchema.parse(json)
  }
  if (current && !servers[current]) servers[current] = {}
  return current ? { current, servers } : { servers }
}

export function createConfigStore(options: { dir?: string; env?: Env } = {}): ConfigStore {
  const env = options.env ?? process.env
  const dir = options.dir ?? resolveConfigDir(env)
  const file = join(dir, CONFIG_FILE_NAME)

  async function load(): Promise<CliConfig> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: {} }
      throw error
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      throw new Error(`Config file ${file} is not valid JSON`)
    }
    try {
      return parseConfig(json)
    } catch (error) {
      throw new Error(`Config file ${file} is invalid: ${(error as Error).message}`)
    }
  }

  async function save(config: CliConfig): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
    const body = { current: config.current, servers: config.servers }
    await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    // `mode` only applies on creation; tighten an existing file too.
    await chmod(file, 0o600)
  }

  async function edit(change: (config: CliConfig) => void): Promise<CliConfig> {
    const config = await load()
    change(config)
    await save(config)
    return config
  }

  return {
    dir,
    file,
    load,
    save,
    putServer(serverUrl, patch, opts = {}) {
      const url = normalizeServerUrl(serverUrl)
      return edit(config => {
        config.servers[url] = { ...config.servers[url], ...patch }
        if (opts.makeCurrent ?? !config.current) config.current = url
      })
    },
    async setCurrent(serverUrl) {
      const url = normalizeServerUrl(serverUrl)
      await edit(config => {
        config.servers[url] ??= {}
        config.current = url
      })
    },
    async clearCredentials(serverUrl) {
      const url = normalizeServerUrl(serverUrl)
      await edit(config => {
        const entry = config.servers[url]
        if (entry) config.servers[url] = entry.instance ? { instance: entry.instance } : {}
      })
    },
    async removeServer(serverUrl) {
      const url = normalizeServerUrl(serverUrl)
      await edit(config => {
        delete config.servers[url]
        if (config.current === url) config.current = undefined
      })
    },
    async resolve(overrides = {}) {
      const config = await load()
      const envUrl = fromEnv(env[ENV.url])
      const envKey = fromEnv(env[ENV.apiKey])
      const [rawUrl, serverUrlSource]: [string | undefined, ResolvedConfig['serverUrlSource']] =
        overrides.serverUrl
          ? [overrides.serverUrl, 'flag']
          : envUrl
            ? [envUrl, 'env']
            : config.current
              ? [config.current, 'config']
              : [undefined, 'none']
      const serverUrl =
        rawUrl === undefined
          ? undefined
          : matchServer(Object.keys(config.servers), rawUrl, { loose: true }).url
      const entry = serverUrl === undefined ? undefined : config.servers[serverUrl]
      const [apiKey, apiKeySource]: [string | undefined, ResolvedConfig['apiKeySource']] = envKey
        ? [envKey, 'env']
        : entry?.apiKey
          ? [entry.apiKey, 'config']
          : [undefined, 'none']
      return {
        serverUrl,
        serverUrlSource,
        current: config.current,
        remembered: entry !== undefined,
        instance: entry?.instance,
        apiKey,
        apiKeySource,
        user: entry?.user,
        debug: Boolean(env[ENV.debug]),
      }
    },
  }
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Which server `input` names, given the remembered ones. An address that normalises to a
 * remembered one is that one. Without a scheme, `input` may also name one by host
 * (`localhost:47101`, whatever its scheme) and, when `loose`, by the start of its address or a
 * parent domain (`example.com` for `https://fling.example.com`), as long as only one matches.
 * Anything else is the address as given, not remembered. Throws when `input` is not an address or
 * matches several servers.
 */
export function matchServer(
  remembered: readonly string[],
  input: string,
  options: { loose?: boolean } = {}
): { url: string; remembered: boolean } {
  const trimmed = input.trim()
  const normalized = safeNormalize(trimmed)
  if (normalized && remembered.includes(normalized)) return { url: normalized, remembered: true }
  if (!HAS_SCHEME.test(trimmed)) {
    const bare = trimmed.replace(/\/+$/, '').toLowerCase()
    const parts = remembered.map(url => {
      const u = new URL(url)
      return { url, host: u.host, hostname: u.hostname, address: `${u.host}${u.pathname}` }
    })
    const tiers = [
      parts.filter(p => p.host === bare || p.address === bare),
      options.loose && bare
        ? parts.filter(p => p.address.startsWith(bare) || p.hostname.endsWith(`.${bare}`))
        : [],
    ]
    for (const found of tiers) {
      const [only] = found
      if (only && found.length === 1) return { url: only.url, remembered: true }
      if (found.length > 1)
        throw new CliError(`"${input}" matches more than one server you have signed in to`, {
          hint: `Use the full address: ${found.map(p => p.url).join(', ')}`,
        })
    }
  }
  if (!normalized)
    throw new CliError(`"${input}" is not a server address`, {
      hint: "Use your Fling's address, e.g. https://fling.example.com.",
    })
  return { url: normalized, remembered: false }
}

/**
 * `fling.example.test` → `https://fling.example.test`; trailing slashes go. Anything after the host
 * is kept (a server may live under a path). Throws on something that isn't a URL.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim()
  const withScheme = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`
  const url = new URL(withScheme)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Not an http(s) URL: ${input}`)
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/** File mode bits (e.g. `0o600`) or null when the path does not exist. */
export async function fileMode(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mode & 0o777
  } catch {
    return null
  }
}

const REDACTED_KEY_CHARS = 10

/** Show only the key prefix — never the full secret. `fling_ab12…` */
export function redactKey(key: string | undefined): string {
  if (!key) return '-'
  return key.length <= REDACTED_KEY_CHARS + 8 ? '****' : `${key.slice(0, REDACTED_KEY_CHARS)}…`
}
