/**
 * A folder's site server, for `fling deploy`, `fling dev` and the local MCP's fling_deploy and
 * fling_dev: find it, bundle it, and say which files are build inputs.
 *
 * The server is the entry `fling.json` names (`"server": "src/api.ts"`), else `server.ts` or
 * `server.js` at the top of the folder. It is bundled with esbuild into one ES module,
 * `_fling/server.mjs` (SERVER_BUNDLE): ESM, minified, es2022, platform neutral (an import that won't
 * exist on every platform fails here, not after a deploy), every import inlined except Node's
 * built-ins (`node:*`, and bare built-in names, which are given the prefix) and Fling's helpers
 * (SERVER_HELPER_MODULE, the CLI package's `/server`), which each runtime resolves to its own. A
 * folder with a prebuilt `_fling/server.mjs` and no entry is published as it is.
 *
 * Build inputs stay behind: the entry, the `server/` folder (the rest of the server's source and
 * private data, which an import puts inside the bundle), `fling.json`, `package.json` and the
 * lockfiles. `fling.json`'s `secrets` and `health` travel with the deploy (DeployRequest.server).
 *
 * Checked before anything is uploaded, as the API checks again: the bundle's size
 * (SERVER_BUNDLE_MAX_BYTES), its imports (`server_not_bundled`) and secrets in it.
 *
 * esbuild is loaded only when there is something to bundle, and the Claude Desktop extension ships
 * without it: there, a server that needs bundling asks for the CLI.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  CLI_PACKAGE,
  isReservedSecretName,
  RESERVED_SECRET_NAMES_TEXT,
  SERVER_BUNDLE,
  SERVER_BUNDLE_MAX_BYTES,
  SERVER_CONFIG_FILE,
  SERVER_HELPER_MODULE,
  type ServerConfig,
  ServerConfigSchema,
  scanBytesForSecrets,
  unbundledImports,
} from '@fling/shared'
import type { Plugin } from 'esbuild'
import { CliError } from './errors.ts'
import {
  buildManifest,
  contentTypeFor,
  type LocalFile,
  type LocalManifest,
  SecretsFoundError,
} from './manifest.ts'
import { formatBytes } from './utils/output.ts'

/** The entries looked for at the top of a folder when `fling.json` names none. */
export const SERVER_ENTRIES = ['server.ts', 'server.js'] as const
/** The folder beside the entry for the rest of the server: a build input. */
export const SERVER_SOURCE_DIR = 'server'
/** Files that build the server and are never published when the folder has one. */
export const BUILD_INPUT_FILES = [
  SERVER_CONFIG_FILE,
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const

/** What a folder says about its server. */
export interface ServerSource {
  /** the entry to bundle (folder-relative), or null for a prebuilt `_fling/server.mjs` */
  entry: string | null
  /** what `fling.json` declares: the secrets and the health path */
  config: ServerConfig
  /** the folder has a `fling.json` */
  configFile: boolean
}

const exists = (path: string) =>
  stat(path).then(
    s => s.isFile(),
    () => false
  )

/** The folder's `fling.json`, checked: `{ server?, secrets?, health? }`; null without one. */
export async function readServerConfig(
  dir: string
): Promise<{ server?: string; config: ServerConfig } | null> {
  let text: string
  try {
    text = await readFile(join(dir, SERVER_CONFIG_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new CliError(`${SERVER_CONFIG_FILE} is not valid JSON`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`${SERVER_CONFIG_FILE} should be an object like {"secrets": ["NAME"]}`)
  }
  const { server, ...rest } = raw as Record<string, unknown>
  if (server !== undefined && (typeof server !== 'string' || !server.trim())) {
    throw new CliError(`${SERVER_CONFIG_FILE}: "server" is the entry to bundle, e.g. "server.ts"`)
  }
  const parsed = ServerConfigSchema.safeParse(rest)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? ` "${issue.path.join('.')}"` : ''
    throw new CliError(`${SERVER_CONFIG_FILE}${where}: ${issue?.message ?? 'invalid'}`, {
      hint: 'It takes "server" (the entry), "secrets" (names like SLACK_WEBHOOK_URL) and "health" (a path under /api/).',
    })
  }
  const reserved = parsed.data.secrets.filter(isReservedSecretName)
  if (reserved.length > 0) {
    throw new CliError(
      `${SERVER_CONFIG_FILE} declares ${reserved.join(', ')}, which no site secret can be called`,
      {
        hint: `${RESERVED_SECRET_NAMES_TEXT} are Fling's and the platform's: rename ${reserved.length === 1 ? 'it' : 'them'} in ${SERVER_CONFIG_FILE} and in the server.`,
      }
    )
  }
  return {
    ...(typeof server === 'string' ? { server: server.replace(/^\.\//, '') } : {}),
    config: parsed.data,
  }
}

/** The folder's server: its entry, or a prebuilt bundle; null when it has neither. */
export async function findServer(dir: string): Promise<ServerSource | null> {
  const file = await readServerConfig(dir)
  const config = file?.config ?? { secrets: [] }
  const configFile = file !== null
  if (file?.server !== undefined) {
    if (!(await exists(join(dir, file.server)))) {
      throw new CliError(
        `${SERVER_CONFIG_FILE} names the server "${file.server}", which isn't there`
      )
    }
    return { entry: file.server, config, configFile }
  }
  for (const entry of SERVER_ENTRIES) {
    if (await exists(join(dir, entry))) return { entry, config, configFile }
  }
  if (await exists(join(dir, SERVER_BUNDLE))) return { entry: null, config, configFile }
  return null
}

/** Whether a folder-relative path is one of the server's build inputs, never published. */
export function isBuildInput(source: ServerSource, path: string, isDir: boolean): boolean {
  if (isDir) return path === SERVER_SOURCE_DIR
  if (path === source.entry) return true
  if ((BUILD_INPUT_FILES as readonly string[]).includes(path)) return true
  // With an entry, the folder's own bundle (an earlier build) gives way to the one built now.
  return source.entry !== null && path === SERVER_BUNDLE
}

/** Node's built-ins by their bare names (`http`, `fs/promises`): what `node:` prefixes. */
const BUILTINS = new Set(builtinModules.filter(m => !m.startsWith('_')))

/** Bare built-in names become external `node:` imports, so npm packages that use them bundle. */
const nodeBuiltins: Plugin = {
  name: 'fling-node-builtins',
  setup(build) {
    build.onResolve({ filter: /^[a-z_/]+$/ }, args =>
      BUILTINS.has(args.path) ? { path: `node:${args.path}`, external: true } : undefined
    )
  },
}

async function loadEsbuild(): Promise<typeof import('esbuild')> {
  try {
    return await import('esbuild')
  } catch {
    throw new CliError('Bundling a site server needs the Fling CLI, which has esbuild', {
      hint: `Install it (\`npm i -g ${CLI_PACKAGE}\`) and run \`fling deploy\`, or publish a folder whose server is already one file, ${SERVER_BUNDLE}.`,
    })
  }
}

/** The esbuild settings every bundle is built with (deploy and dev alike). */
export function bundleOptions(dir: string, entry: string) {
  return {
    absWorkingDir: dir,
    entryPoints: [join(dir, entry)],
    outfile: join(dir, SERVER_BUNDLE),
    bundle: true,
    write: false,
    format: 'esm' as const,
    platform: 'neutral' as const,
    target: 'es2022',
    minify: true,
    legalComments: 'none' as const,
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'import'],
    external: ['node:*', SERVER_HELPER_MODULE],
    plugins: [nodeBuiltins],
    logLevel: 'silent' as const,
  }
}

export interface ServerBundle {
  bytes: Uint8Array
  size: number
  gzipped: number
  ms: number
}

/** esbuild's errors, as the message of a CliError: `file:line: text`, a few of them. */
function bundleFailure(entry: string, error: unknown): CliError {
  const errors = (
    error as { errors?: { text: string; location?: { file: string; line: number } | null }[] }
  ).errors
  const lines = (errors ?? [])
    .slice(0, 8)
    .map(e => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text))
  const text = lines.length ? lines.join('\n  ') : String((error as Error)?.message ?? error)
  const unresolved = lines.some(l => l.includes('Could not resolve'))
  return new CliError(`Could not bundle ${entry}:\n  ${text}`, {
    hint: unresolved
      ? "Install the server's dependencies (`npm install`) in the folder. Only node:* modules stay outside the bundle: a server runs without node_modules."
      : undefined,
  })
}

/** Bundle the entry, then check the bundle as admission will (imports, size, secrets). */
export async function bundleServer(dir: string, entry: string): Promise<ServerBundle> {
  const esbuild = await loadEsbuild()
  const started = performance.now()
  let bytes: Uint8Array
  try {
    const result = await esbuild.build(bundleOptions(dir, entry))
    const out = result.outputFiles?.[0]
    if (!out) throw new Error('esbuild wrote nothing')
    bytes = out.contents
  } catch (error) {
    throw bundleFailure(entry, error)
  }
  checkServerBundle(bytes, entry)
  return {
    bytes,
    size: bytes.byteLength,
    gzipped: gzipSync(bytes).byteLength,
    ms: performance.now() - started,
  }
}

/** A bundle as admission takes it: only `node:*` and the helpers imported, within the size limit. */
export function checkServerBundle(bytes: Uint8Array, from: string = SERVER_BUNDLE): void {
  if (bytes.byteLength > SERVER_BUNDLE_MAX_BYTES) {
    throw new CliError(
      `The server bundle is ${formatBytes(bytes.byteLength)}; the limit is ${formatBytes(SERVER_BUNDLE_MAX_BYTES)}`,
      { hint: 'Leave out large dependencies, or data the server could read with file() instead.' }
    )
  }
  const imports = unbundledImports(new TextDecoder().decode(bytes), SERVER_HELPER_MODULE)
  if (imports.length > 0) {
    throw new CliError(
      `${from} imports ${imports.slice(0, 10).join(', ')}: a server is one file with its dependencies inside, importing only node:* and ${SERVER_HELPER_MODULE}`,
      {
        hint:
          from === SERVER_BUNDLE
            ? 'Bundle it from its source (put server.ts beside it and deploy with the CLI), or drop the import.'
            : 'Use a static import of a package installed in the folder, so the bundler can inline it.',
      }
    )
  }
  const findings = scanBytesForSecrets(bytes, SERVER_BUNDLE)
  if (findings.length > 0) throw new SecretsFoundError(findings)
}

/** A folder's server as a deploy sends it. */
export interface ServerPlan {
  /** the entry bundled, or null for a prebuilt bundle published as it is */
  entry: string | null
  config: ServerConfig
  /** the folder has a `fling.json`: only then does the deploy send `config` (serverRequest) */
  configFile: boolean
  /** the bundle's size, and gzipped (bundled only) */
  size: number
  gzipped?: number
  /** build inputs left out of the manifest */
  buildInputs: string[]
}

/** A manifest for a folder that may have a server: build inputs out, its bundle in. */
export interface SiteBuild {
  local: LocalManifest
  server: ServerPlan | null
  /** things to tell the publisher (a server.ts on a Fling without servers) */
  notes: string[]
}

/**
 * Build the manifest of a folder with its server, if it has one. `servers` is the instance's
 * capability (undefined: not known, the API decides). Without it, a folder that says it has a
 * server (`fling.json` or a bundle) is refused, and a bare `server.ts` is published as a file.
 */
export async function buildSiteManifest(
  dir: string,
  opts: { servers: boolean | undefined; instanceName?: string }
): Promise<SiteBuild> {
  let source = await findServer(dir)
  const notes: string[] = []
  if (source && opts.servers === false) {
    const name = opts.instanceName ?? 'This Fling'
    if (source.configFile || source.entry === null) {
      throw new CliError(`${name} doesn't run site servers`, {
        hint: `Publish the folder without ${source.entry ?? SERVER_BUNDLE} and ${SERVER_CONFIG_FILE}, or ask an admin to turn servers on.`,
      })
    }
    notes.push(
      `${source.entry} is published as a file: ${name} doesn't run site servers (a ${SERVER_CONFIG_FILE} would make it one where they run).`
    )
    source = null
  }
  const buildInputs: string[] = []
  const local = await buildManifest(dir, {
    exclude: source
      ? (path, isDir) => {
          const out = isBuildInput(source, path, isDir)
          if (out) buildInputs.push(isDir ? `${path}/` : path)
          return out
        }
      : undefined,
    allowEmpty: source !== null && source.entry !== null,
  })
  if (!source) return { local, server: null, notes }

  if (source.entry === null) {
    const file = local.files.find(f => f.path === SERVER_BUNDLE)
    if (!file) return { local, server: null, notes }
    const bytes = await readFile(file.absPath)
    checkServerBundle(bytes)
    return {
      local,
      server: {
        entry: null,
        config: source.config,
        configFile: source.configFile,
        size: bytes.byteLength,
        buildInputs,
      },
      notes,
    }
  }
  const bundle = await bundleServer(dir, source.entry)
  const content = Buffer.from(bundle.bytes)
  const file: LocalFile = {
    path: SERVER_BUNDLE,
    absPath: '',
    content,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.byteLength,
    contentType: contentTypeFor(SERVER_BUNDLE),
  }
  const files = [...local.files, file].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )
  return {
    local: { ...local, files, totalBytes: local.totalBytes + file.size },
    server: {
      entry: source.entry,
      config: source.config,
      configFile: source.configFile,
      size: bundle.size,
      gzipped: bundle.gzipped,
      buildInputs,
    },
    notes,
  }
}

/** `bundling server.ts → _fling/server.mjs (474 KB, 102 KB gzipped)`, or the prebuilt line. */
export function describeBundle(plan: ServerPlan): string {
  if (plan.entry === null) return `server: ${SERVER_BUNDLE} as it is (${formatBytes(plan.size)})`
  return `bundling ${plan.entry} → ${SERVER_BUNDLE} (${formatBytes(plan.size)}, ${formatBytes(plan.gzipped ?? 0)} gzipped)`
}

/**
 * DeployRequest.server for a plan: none without a `fling.json`, so a deploy on a base that keeps
 * the base's bundle keeps the base's config (publication.ts), and any other declares nothing.
 */
export const serverRequest = (plan: ServerPlan): { server?: ServerConfig } =>
  plan.configFile
    ? {
        server: {
          secrets: plan.config.secrets,
          ...(plan.config.health ? { health: plan.config.health } : {}),
        },
      }
    : {}
