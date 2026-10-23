/**
 * CLI config: `~/.fling/config.json` (dir 0700, file 0600) holding the server URL, API key and the
 * signed-in user. Env overrides (for CI): `FLING_API_KEY`, `FLING_URL`, and `FLING_CONFIG_DIR` to
 * relocate the directory. `FLING_DEBUG` enables debug lines. This is the only module that reads
 * `process.env`.
 */
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

export const CONFIG_DIR_NAME = '.fling'
export const CONFIG_FILE_NAME = 'config.json'
export const DEFAULT_SERVER_URL = 'https://fling.labs.nearform.com'

export const ENV = {
  apiKey: 'FLING_API_KEY',
  url: 'FLING_URL',
  configDir: 'FLING_CONFIG_DIR',
  debug: 'FLING_DEBUG',
  /** Where to look for files given by name (the .mcpb extension sets it from its settings). */
  downloadsDir: 'FLING_DOWNLOADS_DIR',
} as const

export const cliConfigSchema = z.object({
  serverUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  user: z
    .object({
      email: z.string().optional(),
      name: z.string().optional(),
      userSlug: z.string().optional(),
    })
    .optional(),
})
export type CliConfig = z.infer<typeof cliConfigSchema>

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

export function resolveConfigDir(env: Env = process.env): string {
  return env[ENV.configDir] ?? join(env.HOME ?? homedir(), CONFIG_DIR_NAME)
}

export interface ResolvedConfig {
  serverUrl: string
  serverUrlSource: 'flag' | 'env' | 'config' | 'default'
  apiKey?: string
  apiKeySource: 'env' | 'config' | 'none'
  user?: CliConfig['user']
  debug: boolean
}

export interface ConfigStore {
  readonly dir: string
  readonly file: string
  load(): Promise<CliConfig>
  save(config: CliConfig): Promise<void>
  update(patch: Partial<CliConfig>): Promise<CliConfig>
  /** Remove the key and user, keep `serverUrl`. */
  clearCredentials(): Promise<void>
  /** Merge file + env + an optional `--server` flag into what a command should use. */
  resolve(overrides?: { serverUrl?: string }): Promise<ResolvedConfig>
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      throw new Error(`Config file ${file} is not valid JSON`)
    }
    const parsed = cliConfigSchema.safeParse(json)
    if (!parsed.success) {
      throw new Error(`Config file ${file} is invalid: ${parsed.error.issues[0]?.message}`)
    }
    return parsed.data
  }

  async function save(config: CliConfig): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700).catch(() => {})
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    // `mode` only applies on creation; tighten an existing file too.
    await chmod(file, 0o600)
  }

  return {
    dir,
    file,
    load,
    save,
    async update(patch) {
      const next = { ...(await load()), ...patch }
      await save(next)
      return next
    },
    async clearCredentials() {
      const { serverUrl } = await load()
      await save(serverUrl ? { serverUrl } : {})
    },
    async resolve(overrides = {}) {
      const config = await load()
      const envUrl = fromEnv(env[ENV.url])
      const envKey = fromEnv(env[ENV.apiKey])
      const [serverUrl, serverUrlSource]: [string, ResolvedConfig['serverUrlSource']] =
        overrides.serverUrl
          ? [overrides.serverUrl, 'flag']
          : envUrl
            ? [envUrl, 'env']
            : config.serverUrl
              ? [config.serverUrl, 'config']
              : [DEFAULT_SERVER_URL, 'default']
      const [apiKey, apiKeySource]: [string | undefined, ResolvedConfig['apiKeySource']] = envKey
        ? [envKey, 'env']
        : config.apiKey
          ? [config.apiKey, 'config']
          : [undefined, 'none']
      return {
        serverUrl: serverUrl.replace(/\/+$/, ''),
        serverUrlSource,
        apiKey,
        apiKeySource,
        user: config.user,
        debug: Boolean(env[ENV.debug]),
      }
    },
  }
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
