/**
 * `fling mcp` (and the Claude Desktop extension, mcp-entry.ts) — a stdio MCP server exposing the
 * same operations as the CLI, for agents. It knows every Fling the CLI remembers
 * (`~/.fling/config.json`), re-read on every call so a `fling login` or `fling use` in another
 * terminal takes effect without a restart. Each call goes to the Fling its `server` argument names,
 * with that Fling's stored key; mcp-servers.ts decides what happens without one (the only Fling, the
 * pinned one, or, with several, a request to settle which). `fling_servers` lists them and switches
 * the current one; `fling_login` signs in to a known or new Fling.
 *
 * Tools shared with the remote connector (fling_publish, fling_list, …) take their names,
 * descriptions and schemas from `@fling/shared` mcp-tools, plus `server`. Descriptions and
 * instructions are written when the server starts: with one Fling they name it (its stored
 * `/.well-known/fling`), with none they stay generic, and with several they list them by host.
 * Local extras: fling_deploy (a file, zip or folder on this computer, found by name in Downloads
 * etc. — see locate.ts / inputs.ts), fling_find_files, fling_servers and fling_login. Never relies
 * on Claude's sandbox paths or network.
 *
 * stdout carries only the MCP protocol: nothing here logs, and errors become tool results.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  COMMENTS_NOTE,
  changesAudience,
  describeAudience,
  describeComments,
  describeGroup,
  describeGroups,
  describeVersionFiles,
  type InstanceMetadata,
  isSecretPath,
  isValidSitePath,
  MAX_DEPLOY_BYTES,
  type McpToolDef,
  type McpWording,
  mcpToolsFor,
  mcpWording,
  NEVER_PUBLISHED,
  NOT_READY_NOTE,
  privateAudience,
  reviewUrl,
  shareForFeedback,
} from '@fling/shared'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type ApiClient, CliApiError, createApiClient, type FetchLike } from './api.ts'
import { type LoginResult, loginFlow } from './auth.ts'
import {
  type ConfigStore,
  createConfigStore,
  matchServer,
  type ResolvedConfig,
  serverToAdd,
  systemLocateOptions,
} from './config.ts'
import type { OpenLike } from './context.ts'
import { deploy, NameTakenError, resolveSiteName } from './deploy.ts'
import { CliError, EXIT_NOT_LOGGED_IN, NoServerError } from './errors.ts'
import { defaultNameFor, prepareInput } from './inputs.ts'
import { loadInstance } from './instance.ts'
import {
  FOUND_AS_GIVEN,
  findFiles,
  type LocateOptions,
  type Resolved,
  resolveInput,
} from './locate.ts'
import {
  buildManifest,
  describeSkipped,
  hasRootIndex,
  htmlPages,
  SecretFilesError,
  withHtmlListing,
} from './manifest.ts'
import {
  addServerOnStart,
  describeServer,
  isPinned,
  type KnownServer,
  knownServers,
  knownServersOf,
  rememberedServer,
  ServerNeededError,
  serverArgDescription,
  serverLabel,
  serversInstructions,
  serverToolNote,
} from './mcp-servers.ts'
import { NPX_COMMAND, VERSION } from './package-info.ts'
import { createReadyWaiter, type ReadyWaiter } from './ready.ts'
import {
  addComment,
  archiveSite,
  audiencesEnabled,
  changeGroupMembers,
  checkName,
  commentsEnabled,
  createGroup,
  deleteComment,
  deleteGroup,
  deleteSite,
  getGroup,
  getSite,
  groupsEnabled,
  listComments,
  listGroups,
  listSites,
  renameGroup,
  resolveComment,
  rollback,
  setAudience,
  setVisibility,
  share,
  sitesBaseOf,
  sitesPattern,
  siteUrlFor,
  versionFiles,
  whoami,
} from './sites.ts'
import { silentLogger } from './utils/logger.ts'
import { formatBytes } from './utils/output.ts'

export interface McpDeps {
  store?: ConfigStore
  fetch?: FetchLike
  /** Base for relative `path` arguments (default: process.cwd()). */
  cwd?: string
  /** `--server` given to `fling mcp`. */
  server?: string
  /** Where file names are looked up (default: this machine, with `cwd`). */
  locate?: LocateOptions
  /** Opens the sign-in page (default: the `open` package). */
  open?: OpenLike
  /** How long fling_login waits for the browser before returning (default 30 s). */
  loginWaitMs?: number
  /** How long the login listener stays up in the background (default 5 min). */
  loginTimeoutMs?: number
  /** Waits for a new site / share link to reach the edge (default: real polling, skipped by FLING_NO_WAIT and in tests). */
  waitReady?: ReadyWaiter
  /**
   * The Flings the descriptions name (runMcpServer reads them at start): one → its instance, none →
   * generic wording, several → listed by host.
   */
  servers?: KnownServer[]
}

export const LOGIN_HINT = `Not logged in to Fling. Call fling_login (it opens the browser to sign in), or ask the user to run \`${NPX_COMMAND} login\` in a terminal (in Claude Code: \`! ${NPX_COMMAND} login\`), then try again.`

/** No server configured: only the user knows their Fling's address. */
export const NO_SERVER_HINT = `No Fling server is set up on this computer. Ask the user for their Fling's address, then call fling_login with it as \`server\` (or ask them to run \`${NPX_COMMAND} login <url>\` in a terminal; in Claude Code: \`! ${NPX_COMMAND} login <url>\`), then try again.`

/** Sent at `initialize`: how to use this (local) server. */
export const mcpLocalInstructions = (
  w: McpWording,
  opts: { comments?: boolean; servers?: readonly KnownServer[] } = {}
) =>
  [
    `${w.name} publishes static sites (HTML/CSS/JS, images, documents) at ${w.sitesPattern}. This server runs on the user's computer.`,
    ...[serversInstructions(opts.servers ?? [])].filter(p => p !== undefined),
    'Content you created in this conversation (an HTML page, a report, a small app): call fling_publish with every file inline (text as utf8, binary as base64). ' +
      'Never pass file paths from your sandbox (e.g. /mnt/user-data/outputs/…, /sessions/…) — this computer cannot see them — and never curl or upload from the sandbox.',
    'A file or folder the user has on this computer (a downloaded .html, a .zip, a build folder): call fling_deploy with its path, or just its file name (e.g. "Pitch Deck.html") — ' +
      'it is looked up in Downloads, Desktop, Documents/Claude and Claude Desktop output folders. Use fling_find_files to see recent candidates when unsure which file the user means.',
    'Confirm the site name with the user before publishing (fling_check_name shows whether it is free and, for a path, the generated name). Names are global, first come first served; when one is taken, offer the suggestions.',
    'When there is no index.html but there are HTML pages, fling_deploy and fling_publish do not publish: ask the user whether to generate an index page listing the pages (`listHtml: true`) or publish without one (`listHtml: false`, the root URL 404s), then retry.',
    NEVER_PUBLISHED,
    'Not logged in? Call fling_login, let the user finish signing in in the browser, then retry.',
    `Sites are private (only ${w.privateAudience}) by default; only make one public if asked. Use fling_share for a link people who cannot sign in can open. ${opts.comments ? 'Always give the user the links that come back: the review link first, as the one to share for feedback, then the site URL.' : 'Always give the user the URL that comes back.'}`,
    ...(opts.comments ? [COMMENTS_NOTE(w)] : []),
  ].join('\n\n')

type DeployOutcome =
  | { kind: 'needs_decision'; summary: string; data: unknown }
  | { kind: 'deployed'; summary: string; data: unknown }

/** The Fling a call goes to. */
interface Target {
  client: ApiClient
  url: string
  config: ResolvedConfig
  /** Its `/.well-known/fling` (stored; fetched once if missing). Null when it can't be had. */
  instance(): Promise<InstanceMetadata | null>
}

/** The line a result naming URLs ends with: which Fling it went to. */
const onFling = (url: string, instance: InstanceMetadata | null) =>
  `\nFling: ${serverLabel(url)}${instance ? ` (${instance.name})` : ''}`

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const store = deps.store ?? createConfigStore()
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init))
  const cwd = deps.cwd ?? process.cwd()
  const locate: LocateOptions = deps.locate ?? { ...systemLocateOptions(), cwd }
  const waitReady: ReadyWaiter = deps.waitReady ?? createReadyWaiter()
  const servers = deps.servers ?? []
  const several = servers.length > 1
  const wording = mcpWording(several ? null : servers[0]?.instance)
  const mcpTools = mcpToolsFor(wording)
  const serverArg = z.string().min(1).max(500).optional().describe(serverArgDescription(servers))
  const note = serverToolNote(servers)

  /** A shared tool definition, with `server` and the note on choosing one. */
  const serverTool = <S extends z.ZodRawShape>(
    def: McpToolDef<S>,
    description = def.description
  ) => ({
    title: def.title,
    description: `${description}${note}`,
    inputSchema: { ...def.inputSchema, server: serverArg },
    annotations: def.annotations,
  })

  /** Wait for the edge; never throws. `ready: false` → append the "reload" note. */
  async function edgeReady(url: string, paths: readonly string[]) {
    const r = await waitReady(url, paths).catch(() => ({ ready: false, waitedMs: 0 }))
    return {
      ready: r.ready,
      note: r.ready ? '' : `\nNot reachable yet at ${url}: ${NOT_READY_NOTE}.`,
    }
  }

  /**
   * The resolved config for a call: the Fling `server` names, else the pinned one, else the only
   * one. With several and no `server`, the call is refused with the list (ServerNeededError).
   */
  async function choose(server: string | undefined, tool: string): Promise<ResolvedConfig> {
    if (server !== undefined)
      return store.resolve({ serverUrl: rememberedServer(await store.load(), server) })
    const resolved = await store.resolve({ serverUrl: deps.server })
    if (isPinned(resolved)) return resolved
    const config = await store.load()
    const known = knownServersOf(config)
    if (known.length > 1) throw new ServerNeededError(known, tool)
    const only = known[0]
    return !resolved.serverUrl && only ? store.resolve({ serverUrl: only.url }) : resolved
  }

  async function target(server: string | undefined, tool: string): Promise<Target> {
    const config = await choose(server, tool)
    if (!config.serverUrl) throw new NoServerError('fling')
    if (!config.apiKey) throw new CliError('Not logged in', { exitCode: EXIT_NOT_LOGGED_IN })
    const url = config.serverUrl
    let instance: Promise<InstanceMetadata | null> | undefined
    return {
      client: createApiClient({ serverUrl: url, apiKey: config.apiKey, fetch: fetchImpl }),
      url,
      config,
      instance: () => {
        instance ??= loadInstance(store, config, fetchImpl)
        return instance
      },
    }
  }

  /** Run an operation on the Fling the call chose, and shape its outcome as a tool result. */
  async function run(
    tool: string,
    server: string | undefined,
    op: (t: Target) => Promise<{ summary: string; data: unknown }>
  ): Promise<CallToolResult> {
    try {
      const { summary, data } = await op(await target(server, tool))
      return textResult(`${summary}\n\n${JSON.stringify(data, null, 2)}`)
    } catch (error) {
      return failure(error)
    }
  }

  /** Deploy a prepared folder: the listing decision, the deploy, and the name-taken message. */
  async function deployFolder(
    t: Target,
    dir: string,
    opts: {
      name: string
      nameGiven: boolean
      /** e.g. "the folder" — what a generated name came from. */
      nameFrom?: string
      spa?: boolean
      public?: boolean
      listHtml?: boolean
      retryWith: string
      /** Dotfiles already left out (from a zip or the inline files). */
      skippedDotfiles?: string[]
    }
  ): Promise<DeployOutcome> {
    let local = await buildManifest(dir)
    local.skipped.dotfiles.unshift(...(opts.skippedDotfiles ?? []))
    const skippedNote = describeSkipped(local.skipped)
      .map(l => `\n${l}.`)
      .join('')
    let generatedIndex = false
    if (!hasRootIndex(local)) {
      const pages = htmlPages(local).map(f => f.path)
      if (pages.length > 0 && opts.listHtml === undefined) {
        const shown = pages.slice(0, 20)
        return {
          kind: 'needs_decision',
          summary:
            `Not published yet: there is no index.html at the root, but there ${pages.length === 1 ? 'is 1 HTML page' : `are ${pages.length} HTML pages`}. ` +
            'Ask the user whether to generate an index.html listing them (call again with `listHtml: true`) or to publish ' +
            `without one (\`listHtml: false\` — the root URL will 404, the pages still work at their own paths). Then call ${opts.retryWith} again with the same arguments plus \`listHtml\`.`,
          data: {
            status: 'needs_decision',
            htmlPages: shown,
            ...(pages.length > shown.length ? { moreHtmlPages: pages.length - shown.length } : {}),
            fileCount: local.files.length,
          },
        }
      }
      if (opts.listHtml) {
        local = await withHtmlListing(local, opts.name)
        generatedIndex = true
      }
    }
    const result = await deploy(
      { client: t.client, fetch: fetchImpl },
      { dir, name: opts.name, manifest: local, spa: opts.spa, public: opts.public }
    ).catch((error: unknown) => {
      if (!(error instanceof NameTakenError)) throw error
      const how = opts.nameGiven ? '' : ` (generated from ${opts.nameFrom ?? 'the folder'})`
      const pick = error.suggestions.length
        ? ` Free alternatives: ${error.suggestions.join(', ')}.`
        : ''
      throw new CliError(
        `Not deployed: the site name "${error.siteName}"${how} is taken by someone else on ${serverLabel(t.url)}.${pick} ` +
          `Ask the user which name to use (one of these or their own), then call ${opts.retryWith} again with \`name\`.`
      )
    })
    const what =
      result.status === 'unchanged'
        ? 'Unchanged — already live'
        : result.status === 'repointed'
          ? `Restored version ${result.versionId}`
          : `Deployed ${result.fileCount} files (uploaded ${result.uploaded})`
    const warnings = result.warnings.length ? `\nWarnings:\n- ${result.warnings.join('\n- ')}` : ''
    const edge =
      result.status === 'unchanged'
        ? { ready: true, note: '' }
        : await edgeReady(
            result.url,
            local.files.map(f => f.path)
          )
    const instance = await t.instance()
    const review =
      instance && commentsEnabled(instance) ? reviewUrl(instance.appOrigin, result.name) : undefined
    const listing = generatedIndex ? ' — with a generated index.html listing the HTML pages' : ''
    const head = review
      ? `${what}${listing}.\n${shareForFeedback(review, instance?.name ?? 'Fling')}\nSite: ${result.url} (${result.site.visibility})`
      : `${what}: ${result.url} (${result.site.visibility})${listing}`
    return {
      kind: 'deployed',
      summary:
        `${head}${warnings}${skippedNote}${edge.note}${onFling(t.url, instance)}` +
        `\nTo check exactly which files the site has, call fling_files with name "${result.name}".`,
      data: {
        status: result.status,
        ready: edge.ready,
        server: t.url,
        name: result.name,
        nameGenerated: !opts.nameGiven,
        versionId: result.versionId,
        site: result.site,
        ...(review ? { reviewUrl: review } : {}),
        generatedIndex,
        warnings: result.warnings,
        skipped: local.skipped,
      },
    }
  }

  const server = new McpServer(
    { name: 'fling', version: VERSION },
    {
      instructions: mcpLocalInstructions(wording, {
        comments: servers.some(s => commentsEnabled(s.instance)),
        servers,
      }),
    }
  )
  const { listHtml, spa, public: isPublic } = mcpTools.publish.inputSchema

  server.registerTool(
    'fling_deploy',
    {
      title: 'Deploy a file or folder from this computer',
      description:
        `Fling something that is on the user's computer and return its stable URL (${wording.sitesPattern}): ` +
        "a folder of static files (e.g. a build output like dist/), a single .html file (served as the site's index.html), " +
        'a .zip of a site (extracted; a single top-level folder is unwrapped), or any other single file (.pdf, .svg, .png…, ' +
        'served next to a generated page that shows it). `path` can be absolute, relative to the working directory, or just ' +
        'a file name ("Pitch Deck.html"): names are looked up, newest first, in Downloads, Desktop, Documents/Claude and ' +
        'Claude Desktop output folders, and the result says where the file was found. Never pass paths from your own ' +
        'sandbox (/mnt/user-data/…, /sessions/…): for content you created, use fling_publish. ' +
        'Without `name`, a name is generated: from the file name for files ("Pitch Deck (1).html" → pitch-deck), from the ' +
        'project and folder for folders (~/work/rocketpod/docs → rocketpod-docs). Site names are one global namespace, first ' +
        'come first served — confirm the name with the user first (fling_check_name with `path` shows the generated one). ' +
        'If the name is taken it fails with free suggestions — ask the user to pick one, then retry with `name`. ' +
        'If there is no index.html but there are HTML pages, it does not deploy: ask the user whether to generate an index ' +
        'page listing them (`listHtml: true`) or deploy without one (`listHtml: false`), then retry. ' +
        `Re-deploying identical content is a no-op. Sites are private (only ${wording.privateAudience}) unless \`public\` is set. ` +
        `${NEVER_PUBLISHED}${note}`,
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'File or folder on this computer: absolute, relative to the working directory, or just its name (looked up in Downloads, Desktop and Claude output folders)'
          ),
        name: z
          .string()
          .optional()
          .describe(
            'Site name (lowercase letters, digits, single hyphens; max 50). Defaults to a name generated from the file or folder'
          ),
        spa,
        public: isPublic,
        listHtml,
        server: serverArg,
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    args =>
      run('fling_deploy', args.server, async t => {
        const located = await resolveInput(args.path, locate)
        const prepared = await prepareInput(located.path)
        try {
          const name =
            args.name !== undefined
              ? resolveSiteName(prepared.dir, args.name)
              : prepared.defaultName
          const outcome = await deployFolder(t, prepared.dir, {
            name,
            nameGiven: args.name !== undefined,
            nameFrom: prepared.kind === 'folder' ? 'the folder' : 'the file name',
            spa: args.spa,
            public: args.public,
            listHtml: args.listHtml,
            retryWith: 'fling_deploy',
            skippedDotfiles: prepared.skippedDotfiles,
          })
          const where =
            located.foundIn === FOUND_AS_GIVEN
              ? ''
              : `Found "${basename(located.path)}" in ${located.foundIn}: ${located.path}\n`
          return {
            summary: `${where}${outcome.summary}`,
            data: {
              ...(outcome.data as object),
              source: {
                path: located.path,
                foundIn: located.foundIn,
                kind: prepared.kind,
                ...(located.alternatives.length ? { alternatives: located.alternatives } : {}),
              },
            },
          }
        } finally {
          await prepared.cleanup()
        }
      })
  )

  server.registerTool(
    'fling_find_files',
    {
      title: 'Find files to fling',
      description:
        'List recent things on this computer that could be flung, newest first: .html/.htm and .zip files, and folders ' +
        'containing an index.html, from the working directory, Downloads, Desktop, Documents/Claude, ~/Claude and Claude ' +
        'Desktop output folders. Each has its path, where it was found, size and modified time. Use it when the user ' +
        'refers to a file they downloaded or that Claude Desktop saved, then pass the chosen path (or name) to fling_deploy.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Only names containing this text (case-insensitive), e.g. "deck"'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
        days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Only things modified in the last N days (default 14)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async args => {
      try {
        const { files, searched, complete } = await findFiles(locate, args)
        const lines = files.map(
          f =>
            `- ${f.path} (${f.kind}, ${f.foundIn}, ${formatBytes(f.size)}, modified ${f.modified})`
        )
        const summary = files.length
          ? `${files.length} recent item(s), newest first:\n${lines.join('\n')}`
          : `Nothing found from the last ${args.days ?? 14} days${args.query ? ` matching "${args.query}"` : ''}.`
        const data = {
          files,
          searched: searched.map(r => ({ label: r.label, path: r.path })),
          ...(complete ? {} : { truncated: true }),
        }
        return textResult(`${summary}\n\n${JSON.stringify(data, null, 2)}`)
      } catch (error) {
        return failure(error)
      }
    }
  )

  const publishDef = mcpTools.publish
  server.registerTool(
    publishDef.name,
    serverTool(
      publishDef,
      // This server has no chunked upload tools; big sites go through fling_deploy instead.
      publishDef.description.replace(
        /\(whole site, up to [^;]*; bigger sites: fling_upload_begin \/ fling_upload_file \/ fling_upload_finish\)/,
        '(whole site; for a big site that is already on this computer, use fling_deploy with its folder)'
      )
    ),
    args =>
      run(publishDef.name, args.server, async t => {
        const name = resolveSiteName('.', args.name)
        const tmp = await mkdtemp(join(tmpdir(), 'fling-publish-'))
        try {
          const { skippedDotfiles } = await writeInlineFiles(tmp, args.files)
          return await deployFolder(t, tmp, {
            skippedDotfiles,
            name,
            nameGiven: true,
            spa: args.spa,
            public: args.public,
            listHtml: args.listHtml,
            retryWith: 'fling_publish',
          })
        } finally {
          await rm(tmp, { recursive: true, force: true })
        }
      })
  )

  server.registerTool(
    'fling_check_name',
    {
      ...serverTool(mcpTools.checkName),
      description:
        `${mcpTools.checkName.description} Pass \`path\` instead of \`name\` to see the name fling_deploy would ` +
        `generate for a file or folder on this computer (same lookup as fling_deploy), so you can confirm it with the user.${note}`,
      inputSchema: {
        name: z.string().min(1).max(200).optional().describe('Site name to check'),
        path: z
          .string()
          .optional()
          .describe('File or folder whose generated default name to check (path or file name)'),
        server: serverArg,
      },
    },
    args =>
      run('fling_check_name', args.server, async t => {
        if (args.name === undefined && args.path === undefined)
          throw new CliError('Pass `name` or `path`')
        let name = args.name
        let source: Resolved | undefined
        if (name === undefined) {
          source = await resolveInput(args.path as string, locate)
          name = defaultNameFor(source.path, source.isDirectory)
        }
        const check = await checkName(t.client, name)
        const base = check.status === 'invalid' ? null : sitesBaseOf(await t.instance())
        const url = base ? siteUrlFor(name, base) : null
        const suggestions = check.suggestions.length
          ? ` Suggestions: ${check.suggestions.join(', ')}.`
          : ''
        const summary = {
          available: `"${name}" is available${url ? ` → ${url}` : ''}.`,
          yours: `"${name}" is the user's existing site${url ? ` (${url})` : ''} — deploying updates it.`,
          taken: `"${name}" is taken by someone else.${suggestions}`,
          invalid: `"${name}" is not a valid site name.${suggestions}`,
        }[check.status]
        return {
          summary,
          data: {
            ...check,
            url,
            server: t.url,
            ...(source
              ? { generated: true, source: { path: source.path, foundIn: source.foundIn } }
              : {}),
          },
        }
      })
  )

  /** Sign-ins waiting for the browser, by server. */
  const pendingLogins = new Map<string, { url?: string; done: Promise<LoginResult> }>()

  server.registerTool(
    'fling_login',
    {
      title: 'Sign in to Fling',
      description:
        `Sign the user in to ${several ? 'a Fling' : wording.name}: opens their browser to sign in with ${wording.signIn} and stores ` +
        'the key on this computer (shared with the fling CLI). Waits up to ~30 seconds; if sign-in is not finished by ' +
        'then, it keeps waiting in the background for up to 5 minutes — tell the user to finish signing in in the ' +
        'browser, then retry what you were doing. Call it when another tool says the user is not logged in. ' +
        'Pass `server` (its address) to sign in to another Fling, including one not set up on this computer yet: it is ' +
        'remembered, and becomes the current one only when none is.' +
        note,
      inputSchema: {
        server: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe(
            `The Fling to sign in to: its address (e.g. "https://fling.example.com"), or the host of one set up on this computer. ${
              several
                ? `Required while several Flings are set up (${servers.map(s => serverLabel(s.url)).join(', ')})`
                : `Omit it to use ${servers[0] ? serverLabel(servers[0].url) : 'the one this computer knows'}`
            }`
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async args => {
      try {
        let serverUrl: string | undefined
        if (args.server !== undefined) {
          const config = await store.load()
          try {
            serverUrl = matchServer(Object.keys(config.servers), args.server, { loose: true }).url
          } catch (error) {
            const known = knownServersOf(config).map(s => `- ${describeServer(s)}`)
            throw new CliError((error as Error).message, {
              hint: known.length ? `The Flings set up on this computer:\n${known.join('\n')}` : '',
            })
          }
        } else {
          serverUrl = (await choose(undefined, 'fling_login')).serverUrl
        }
        if (!serverUrl) throw new NoServerError('fling')
        const config = await store.resolve({ serverUrl })
        let login = pendingLogins.get(serverUrl)
        if (config.apiKey && !login) {
          const me = await whoami(
            createApiClient({ serverUrl, apiKey: config.apiKey, fetch: fetchImpl })
          ).catch(() => null)
          if (me) return textResult(`Already signed in to ${serverUrl} as ${me.email}.`)
        }
        if (!login) {
          const started: { url?: string; done: Promise<LoginResult> } = {
            done: Promise.resolve() as unknown as Promise<LoginResult>,
          }
          started.done = loginFlow({
            serverUrl,
            store,
            log: silentLogger,
            open: deps.open ?? (async url => (await import('open')).default(url)),
            fetch: fetchImpl,
            timeoutMs: deps.loginTimeoutMs,
            // Signing in to another Fling leaves the CLI's current server as it is.
            makeCurrent: !config.current || config.current === serverUrl,
            onAuthUrl: url => {
              started.url = url
            },
          })
          const key = serverUrl
          started.done
            .catch(() => {})
            .finally(() => {
              if (pendingLogins.get(key) === started) pendingLogins.delete(key)
            })
          pendingLogins.set(serverUrl, started)
          login = started
        }
        const current = login
        const waited = await Promise.race([
          current.done.then(
            r => ({ ok: true as const, r }),
            (e: unknown) => ({ ok: false as const, e })
          ),
          new Promise<null>(r => setTimeout(() => r(null), deps.loginWaitMs ?? 30_000).unref?.()),
        ])
        if (waited === null)
          return textResult(
            'Finish signing in in your browser, then try again. ' +
              `(The sign-in page is open; if it did not open, visit: ${current.url ?? 'the Fling site'} — this stays valid for 5 minutes.)`
          )
        if (!waited.ok) throw waited.e
        return textResult(
          `Signed in as ${waited.r.user.email} (${waited.r.serverUrl}, ${waited.r.instance.name}).`
        )
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'fling_servers',
    {
      title: 'List the Flings on this computer',
      description:
        'List the Flings set up on this computer, read now: each one\'s address, name, who is signed in (or "signed ' +
        'out") and which is current, the user\'s usual one. Call it when unsure which Fling the user means or which ' +
        'exist; the list may have changed since this conversation started. Pass `use` to make one the current Fling, the ' +
        `same as running \`${NPX_COMMAND} use <server>\`: it changes the default of the fling CLI too, so only do it when ` +
        'the user asks. It does not replace passing `server` to the other tools while several Flings are set up.',
      inputSchema: {
        use: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe(
            'Make this Fling current (address, host or unique part of it), like `fling use`'
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async args => {
      try {
        let switched = ''
        if (args.use !== undefined) {
          const url = rememberedServer(await store.load(), args.use)
          await store.setCurrent(url)
          switched = `Now using ${serverLabel(url)} as the current Fling (as \`fling use\` does).\n`
        }
        const config = await store.load()
        const known = knownServersOf(config)
        const pinned = await store.resolve({ serverUrl: deps.server })
        const summary = known.length
          ? `${switched}${known.length} Fling(s) set up on this computer:\n${known.map(s => `- ${describeServer(s)}`).join('\n')}` +
            (isPinned(pinned) && pinned.serverUrl
              ? `\nCalls without \`server\` go to ${serverLabel(pinned.serverUrl)} (set by this server's configuration).`
              : known.length > 1
                ? '\nPass `server` on every call: the Fling settled on for this conversation.'
                : '')
          : NO_SERVER_HINT
        const data = {
          current: config.current ?? null,
          servers: known.map(s => ({
            url: s.url,
            host: serverLabel(s.url),
            instance: s.instance?.name ?? null,
            signedIn: s.signedIn,
            email: s.email ?? null,
            current: s.current,
          })),
        }
        return textResult(`${summary}\n\n${JSON.stringify(data, null, 2)}`)
      } catch (error) {
        return failure(error)
      }
    }
  )

  const t = mcpTools
  server.registerTool(t.list.name, serverTool(t.list), args =>
    run(t.list.name, args.server, async ({ client, url }) => {
      const sites = await listSites(client, { archived: args.archived, sort: args.sort })
      return { summary: `${sites.length} site(s) on ${serverLabel(url)}`, data: { sites } }
    })
  )

  /** Who may open a private site on the call's Fling, for copy. */
  const membersOn = async (target: Target) => {
    const instance = await target.instance()
    return instance ? privateAudience(instance) : 'anyone signed in to this Fling'
  }

  server.registerTool(t.info.name, serverTool(t.info), args =>
    run(t.info.name, args.server, async target => {
      const site = await getSite(target.client, args.name)
      const access = site.audience ? `\n${describeAudience(site, await membersOn(target))}` : ''
      return { summary: `${site.name}: ${site.url}${access}`, data: site }
    })
  )

  server.registerTool(t.files.name, serverTool(t.files), args =>
    run(t.files.name, args.server, async ({ client }) => {
      const result = await versionFiles(client, args.name, args.versionId)
      return {
        summary: describeVersionFiles(result.name, result, {
          current: result.current,
          url: result.url,
        }),
        data: result,
      }
    })
  )

  server.registerTool(t.share.name, serverTool(t.share), args =>
    run(t.share.name, args.server, async ({ client }) => {
      if (args.refresh && args.revoke) throw new CliError('Use either refresh or revoke, not both')
      const result = await share(client, args.name, args)
      if (result.action === 'revoked')
        return { summary: `Share link for ${args.name} revoked`, data: result }
      let edge = { ready: true, note: '' }
      if (result.action !== 'existing') {
        const files = await versionFiles(client, args.name).catch(() => null)
        edge = await edgeReady(result.shareUrl, files?.files.map(f => f.path) ?? [])
      }
      return {
        summary: `Share link (${result.action}): ${result.shareUrl} — anyone with it can view the site${edge.note}`,
        data: { ...result, ready: edge.ready },
      }
    })
  )

  server.registerTool(t.setVisibility.name, serverTool(t.setVisibility), args =>
    run(t.setVisibility.name, args.server, async ({ client }) => {
      const site = await setVisibility(client, args.name, args.visibility)
      return { summary: `${site.name} is now ${site.visibility}: ${site.url}`, data: site }
    })
  )

  // Audiences: offered when a Fling known at start has them; each call checks the Fling it goes to.
  if (servers.some(s => audiencesEnabled(s.instance))) {
    server.registerTool(t.setAudience.name, serverTool(t.setAudience), args =>
      run(t.setAudience.name, args.server, async target => {
        const instance = await target.instance()
        if (instance && !audiencesEnabled(instance)) {
          throw new CliError(
            `${instance.name} (${serverLabel(target.url)}) can't limit a site to listed people`
          )
        }
        const change = {
          add: args.add,
          remove: args.remove,
          set: args.set,
          addGroups: args.addGroups,
          removeGroups: args.removeGroups,
          setGroups: args.setGroups,
          clear: args.clear,
        }
        if (!changesAudience(change)) {
          throw new CliError(
            'Pass `add`, `remove`, `set`, `addGroups`, `removeGroups`, `setGroups` or `clear`'
          )
        }
        const site = await setAudience(target.client, args.name, change)
        return {
          summary: `${site.name}: ${describeAudience(site, await membersOn(target))}${onFling(target.url, instance)}`,
          data: site,
        }
      })
    )
  }

  // Groups: offered when a Fling known at start has them; each call checks the Fling it goes to.
  if (servers.some(s => groupsEnabled(s.instance))) {
    /** The call's Fling, refused when it has no groups. */
    const withGroups = async (target: Target) => {
      const instance = await target.instance()
      if (instance && !groupsEnabled(instance)) {
        throw new CliError(`${instance.name} (${serverLabel(target.url)}) has no groups`)
      }
      return instance
    }

    server.registerTool(t.groups.name, serverTool(t.groups), args =>
      run(t.groups.name, args.server, async target => {
        const instance = await withGroups(target)
        const [groups, me] = await Promise.all([
          listGroups(target.client, { mine: args.mine }),
          whoami(target.client),
        ])
        return {
          summary: `${groups.length} ${args.mine ? 'of your ' : ''}group(s)${onFling(target.url, instance)}\n${describeGroups(groups, me.email)}`,
          data: { groups },
        }
      })
    )

    server.registerTool(t.groupShow.name, serverTool(t.groupShow), args =>
      run(t.groupShow.name, args.server, async target => {
        await withGroups(target)
        const group = await getGroup(target.client, args.slug)
        return { summary: describeGroup(group), data: group }
      })
    )

    server.registerTool(t.groupCreate.name, serverTool(t.groupCreate), args =>
      run(t.groupCreate.name, args.server, async target => {
        const instance = await withGroups(target)
        const group = await createGroup(target.client, {
          slug: args.slug,
          name: args.name,
          members: args.members,
        })
        return {
          summary: `Created ${describeGroup(group)}${onFling(target.url, instance)}`,
          data: group,
        }
      })
    )

    server.registerTool(t.groupMembers.name, serverTool(t.groupMembers), args =>
      run(t.groupMembers.name, args.server, async target => {
        await withGroups(target)
        if (!args.add?.length && !args.remove?.length) {
          throw new CliError('Pass `add` or `remove`')
        }
        const group = await changeGroupMembers(target.client, args.slug, {
          add: args.add,
          remove: args.remove,
        })
        return { summary: describeGroup(group), data: group }
      })
    )

    server.registerTool(t.groupRename.name, serverTool(t.groupRename), args =>
      run(t.groupRename.name, args.server, async target => {
        await withGroups(target)
        const group = await renameGroup(target.client, args.slug, args.name)
        return { summary: describeGroup(group), data: group }
      })
    )

    server.registerTool(t.groupDelete.name, serverTool(t.groupDelete), args =>
      run(t.groupDelete.name, args.server, async target => {
        await withGroups(target)
        const result = await deleteGroup(target.client, args.slug)
        return {
          summary: `Group ${args.slug} deleted. Sites whose audience named it keep their restriction: anyone it let in has lost access`,
          data: result,
        }
      })
    )
  }

  server.registerTool(t.archive.name, serverTool(t.archive), args =>
    run(t.archive.name, args.server, async ({ client }) => {
      const site = await archiveSite(client, args.name, { unarchive: args.unarchive })
      return { summary: `${site.name} ${args.unarchive ? 'restored' : 'archived'}`, data: site }
    })
  )

  server.registerTool(t.delete.name, serverTool(t.delete), args =>
    run(t.delete.name, args.server, async ({ client, url }) => {
      const result = await deleteSite(client, args.name)
      return { summary: `${args.name} deleted from ${serverLabel(url)}`, data: result }
    })
  )

  server.registerTool(t.rollback.name, serverTool(t.rollback), args =>
    run(t.rollback.name, args.server, async ({ client }) => {
      const site = await rollback(client, args.name, args.versionId)
      return {
        summary: `${site.name} now serves version ${site.currentVersionId}: ${site.url}`,
        data: site,
      }
    })
  )

  // Comments: offered when a Fling known at start has them; each call checks the Fling it goes to.
  if (servers.some(s => commentsEnabled(s.instance))) {
    /** The review page of `name` on the call's Fling; refuses when that Fling has no comments. */
    async function reviewOn(target: Target) {
      const instance = await target.instance()
      if (instance?.capabilities.comments === false)
        throw new CliError(`${instance.name} (${serverLabel(target.url)}) has comments turned off`)
      const appOrigin = instance?.appOrigin ?? target.url
      return {
        review: (name: string) => reviewUrl(appOrigin, name),
        fling: onFling(target.url, instance),
      }
    }

    server.registerTool(t.commentsList.name, serverTool(t.commentsList), args =>
      run(t.commentsList.name, args.server, async target => {
        const { review, fling } = await reviewOn(target)
        const list = await listComments(target.client, args.name, { path: args.path })
        const reviewPage = review(list.site.name)
        return {
          summary: `${describeComments(list, { includeResolved: args.includeResolved, reviewUrl: reviewPage })}${fling}`,
          data: { ...list, reviewUrl: reviewPage },
        }
      })
    )

    server.registerTool(t.commentAdd.name, serverTool(t.commentAdd), args =>
      run(t.commentAdd.name, args.server, async target => {
        const { review, fling } = await reviewOn(target)
        const comment = await addComment(target.client, args.name, {
          body: args.body,
          path: args.path,
          parentId: args.replyTo,
        })
        const what = comment.parentId ? `Replied to thread ${comment.parentId}` : 'Comment added'
        return {
          summary: `${what} on ${args.name} (${comment.path}, id ${comment.id}). Review page: ${review(args.name)}${fling}`,
          data: comment,
        }
      })
    )

    server.registerTool(t.commentResolve.name, serverTool(t.commentResolve), args =>
      run(t.commentResolve.name, args.server, async target => {
        await reviewOn(target)
        const comment = await resolveComment(target.client, args.name, args.id, !args.reopen)
        return {
          summary: `Thread ${comment.id} on ${args.name} ${args.reopen ? 'reopened' : 'resolved'}`,
          data: comment,
        }
      })
    )

    server.registerTool(t.commentDelete.name, serverTool(t.commentDelete), args =>
      run(t.commentDelete.name, args.server, async target => {
        await reviewOn(target)
        const result = await deleteComment(target.client, args.name, args.id)
        return { summary: `Comment ${args.id} on ${args.name} deleted`, data: result }
      })
    )
  }

  server.registerTool(t.whoami.name, serverTool(t.whoami), args =>
    run(t.whoami.name, args.server, async target => {
      const me = await whoami(target.client)
      const instance = await target.instance()
      const base = sitesBaseOf(instance)
      return {
        summary: `Signed in to ${serverLabel(target.url)}${instance ? ` (${instance.name})` : ''} as ${me.email} (sites are served at ${sitesPattern(base)})`,
        data: { ...me, server: target.url },
      }
    })
  )

  return server
}

const textResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })

/**
 * Inline files (fling_publish) → a folder: `./a` and `/a` mean `a`; no traversal, no duplicates.
 * Dotfiles (`.env`, `.well-known/x`) are left out and returned in `skippedDotfiles`; secret files
 * (`server.key`, `id_rsa`…) are refused. Contents are scanned for secrets by buildManifest.
 */
export async function writeInlineFiles(
  dir: string,
  files: readonly { path: string; content: string; encoding?: 'utf8' | 'base64' }[]
): Promise<{ skippedDotfiles: string[] }> {
  const seen = new Set<string>()
  const skippedDotfiles: string[] = []
  const secretFiles: string[] = []
  let total = 0
  for (const f of files) {
    const path = f.path.replace(/^(\.\/)+/, '').replace(/^\/+/, '')
    const segments = path.split('/')
    if (
      path &&
      !path.includes('\\') &&
      segments.every(s => s !== '' && s !== '.' && s !== '..') &&
      segments.some(s => s.startsWith('.'))
    ) {
      skippedDotfiles.push(path)
      continue
    }
    if (!isValidSitePath(path)) throw new CliError(`Invalid file path: "${f.path}"`)
    if (isSecretPath(path)) {
      secretFiles.push(path)
      continue
    }
    if (seen.has(path)) throw new CliError(`"${path}" is listed twice`)
    seen.add(path)
    const bytes = Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8')
    total += bytes.length
    if (total > MAX_DEPLOY_BYTES)
      throw new CliError(`The site is larger than ${formatBytes(MAX_DEPLOY_BYTES)}`)
    const target = join(dir, ...path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
  if (secretFiles.length > 0) throw new SecretFilesError(secretFiles)
  return { skippedDotfiles }
}

/**
 * An error as a tool result. A call that needs `server` is not a failure: it answers with the list
 * of Flings so the model can ask the user.
 */
function failure(error: unknown): CallToolResult {
  if (error instanceof ServerNeededError) {
    const data = {
      status: 'needs_server',
      servers: error.servers.map(s => ({
        url: s.url,
        host: serverLabel(s.url),
        instance: s.instance?.name ?? null,
        signedIn: s.signedIn,
        email: s.email ?? null,
        current: s.current,
      })),
    }
    return textResult(`${error.message}\n\n${JSON.stringify(data, null, 2)}`)
  }
  return { isError: true, content: [{ type: 'text', text: describeError(error) }] }
}

function describeError(error: unknown): string {
  if (error instanceof NoServerError) return NO_SERVER_HINT
  if (error instanceof CliError && error.exitCode === EXIT_NOT_LOGGED_IN) return LOGIN_HINT
  if (error instanceof CliApiError && error.status === 401) return LOGIN_HINT
  if (error instanceof CliError)
    return error.hint ? `${error.message}\n${error.hint}` : error.message
  return error instanceof Error ? error.message : String(error)
}

export async function runMcpServer(deps: McpDeps = {}): Promise<void> {
  const store = deps.store ?? createConfigStore()
  const fetchImpl: FetchLike = deps.fetch ?? ((i, init) => fetch(i, init))
  // Remember the Fling the extension came from, and read the known ones for the descriptions;
  // never fail to start over either.
  await addServerOnStart(store, serverToAdd(), fetchImpl).catch(() => {})
  const servers =
    deps.servers ?? (await knownServers(store, fetchImpl, deps.server).catch(() => []))
  const server = createMcpServer({ ...deps, store, servers })
  await server.connect(new StdioServerTransport())
}
