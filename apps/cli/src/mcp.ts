/**
 * `fling mcp` (and the Claude Desktop extension, mcp-entry.ts) — a stdio MCP server exposing the
 * same operations as the CLI, for agents. It reuses the CLI's stored login (`~/.fling/config.json`
 * or `FLING_API_KEY`), re-read on every call so a `fling login` in another terminal takes effect
 * without a restart; `fling_login` runs the same browser sign-in itself.
 *
 * Tools shared with the remote connector (fling_publish, fling_list, …) take their names,
 * descriptions and schemas from `@fling/shared` mcp-tools. Local extras: fling_deploy (a file,
 * zip or folder on this computer, found by name in Downloads etc. — see locate.ts / inputs.ts),
 * fling_find_files and fling_login. Never relies on Claude's sandbox paths or network.
 *
 * stdout carries only the MCP protocol: nothing here logs, and errors become tool results.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  describeVersionFiles,
  isValidSitePath,
  MAX_DEPLOY_BYTES,
  type McpToolDef,
  mcpTools,
} from '@fling/shared'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { type ApiClient, CliApiError, createApiClient, type FetchLike } from './api.ts'
import { type LoginResult, loginFlow } from './auth.ts'
import { type ConfigStore, createConfigStore, systemLocateOptions } from './config.ts'
import type { OpenLike } from './context.ts'
import { deploy, NameTakenError, resolveSiteName } from './deploy.ts'
import { CliError, EXIT_NOT_LOGGED_IN } from './errors.ts'
import { defaultNameFor, prepareInput } from './inputs.ts'
import {
  FOUND_AS_GIVEN,
  findFiles,
  type LocateOptions,
  type Resolved,
  resolveInput,
} from './locate.ts'
import { buildManifest, hasRootIndex, htmlPages, withHtmlListing } from './manifest.ts'
import { NPX_COMMAND, VERSION } from './package-info.ts'
import {
  archiveSite,
  checkName,
  deleteSite,
  discoverSitesBase,
  getSite,
  listSites,
  rollback,
  setVisibility,
  share,
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
}

export const LOGIN_HINT = `Not logged in to Fling. Call fling_login (it opens the browser to sign in with Nearform Google), or ask the user to run \`${NPX_COMMAND} login\` in a terminal (in Claude Code: \`! ${NPX_COMMAND} login\`), then try again.`

/** Sent at `initialize`: how to use this (local) server. */
export const MCP_LOCAL_INSTRUCTIONS = [
  "Fling publishes static sites (HTML/CSS/JS, images, documents) for Nearform staff at https://<name>.fling.labs.nearform.com. This server runs on the user's computer.",
  'Content you created in this conversation (an HTML page, a report, a small app): call fling_publish with every file inline (text as utf8, binary as base64). ' +
    'Never pass file paths from your sandbox (e.g. /mnt/user-data/outputs/…, /sessions/…) — this computer cannot see them — and never curl or upload from the sandbox.',
  'A file or folder the user has on this computer (a downloaded .html, a .zip, a build folder): call fling_deploy with its path, or just its file name (e.g. "Pitch Deck.html") — ' +
    'it is looked up in Downloads, Desktop, Documents/Claude and Claude Desktop output folders. Use fling_find_files to see recent candidates when unsure which file the user means.',
  'Confirm the site name with the user before publishing (fling_check_name shows whether it is free and, for a path, the generated name). Names are global, first come first served; when one is taken, offer the suggestions.',
  'When there is no index.html but there are HTML pages, fling_deploy and fling_publish do not publish: ask the user whether to generate an index page listing the pages (`listHtml: true`) or publish without one (`listHtml: false`, the root URL 404s), then retry.',
  'Not logged in? Call fling_login, let the user finish signing in in the browser, then retry.',
  'Sites are private (Nearformers only) by default; only make one public if asked. Use fling_share for a link people outside Nearform can open. Always give the user the URL that comes back.',
].join('\n\n')

const toolDef = <S extends z.ZodRawShape>(def: McpToolDef<S>) => ({
  title: def.title,
  description: def.description,
  inputSchema: def.inputSchema,
  annotations: def.annotations,
})

type DeployOutcome =
  | { kind: 'needs_decision'; summary: string; data: unknown }
  | { kind: 'deployed'; summary: string; data: unknown }

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const store = deps.store ?? createConfigStore()
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init))
  const cwd = deps.cwd ?? process.cwd()
  const locate: LocateOptions = deps.locate ?? { ...systemLocateOptions(), cwd }

  async function client(): Promise<ApiClient> {
    const config = await store.resolve({ serverUrl: deps.server })
    if (!config.apiKey) throw new CliError('Not logged in', { exitCode: EXIT_NOT_LOGGED_IN })
    return createApiClient({ serverUrl: config.serverUrl, apiKey: config.apiKey, fetch: fetchImpl })
  }

  /** Run an operation and shape its outcome as a tool result. */
  async function run(
    op: (c: ApiClient) => Promise<{ summary: string; data: unknown }>
  ): Promise<CallToolResult> {
    try {
      const { summary, data } = await op(await client())
      return { content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] }
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: describeError(error) }] }
    }
  }

  /** Deploy a prepared folder: the listing decision, the deploy, and the name-taken message. */
  async function deployFolder(
    c: ApiClient,
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
    }
  ): Promise<DeployOutcome> {
    let local = await buildManifest(dir)
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
      { client: c, fetch: fetchImpl },
      { dir, name: opts.name, manifest: local, spa: opts.spa, public: opts.public }
    ).catch((error: unknown) => {
      if (!(error instanceof NameTakenError)) throw error
      const how = opts.nameGiven ? '' : ` (generated from ${opts.nameFrom ?? 'the folder'})`
      const pick = error.suggestions.length
        ? ` Free alternatives: ${error.suggestions.join(', ')}.`
        : ''
      throw new CliError(
        `Not deployed: the site name "${error.siteName}"${how} is taken by someone else.${pick} ` +
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
    return {
      kind: 'deployed',
      summary:
        `${what}: ${result.url} (${result.site.visibility})${generatedIndex ? ' — with a generated index.html listing the HTML pages' : ''}${warnings}` +
        `\nTo check exactly which files the site has, call fling_files with name "${result.name}".`,
      data: {
        status: result.status,
        name: result.name,
        nameGenerated: !opts.nameGiven,
        versionId: result.versionId,
        site: result.site,
        generatedIndex,
        warnings: result.warnings,
      },
    }
  }

  const server = new McpServer(
    { name: 'fling', version: VERSION },
    { instructions: MCP_LOCAL_INSTRUCTIONS }
  )
  const { listHtml, spa, public: isPublic } = mcpTools.publish.inputSchema

  server.registerTool(
    'fling_deploy',
    {
      title: 'Deploy a file or folder from this computer',
      description:
        "Fling something that is on the user's computer and return its stable URL (https://<name>.fling.labs.nearform.com): " +
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
        'Re-deploying identical content is a no-op. Sites are private to signed-in Nearformers unless `public` is set.',
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
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    args =>
      run(async c => {
        const located = await resolveInput(args.path, locate)
        const prepared = await prepareInput(located.path)
        try {
          const name =
            args.name !== undefined
              ? resolveSiteName(prepared.dir, args.name)
              : prepared.defaultName
          const outcome = await deployFolder(c, prepared.dir, {
            name,
            nameGiven: args.name !== undefined,
            nameFrom: prepared.kind === 'folder' ? 'the folder' : 'the file name',
            spa: args.spa,
            public: args.public,
            listHtml: args.listHtml,
            retryWith: 'fling_deploy',
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
        return {
          content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
        }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: describeError(error) }] }
      }
    }
  )

  const publishDef = mcpTools.publish
  server.registerTool(
    publishDef.name,
    {
      ...toolDef(publishDef),
      // This server has no chunked upload tools; big sites go through fling_deploy instead.
      description: publishDef.description.replace(
        /\(whole site, up to [^;]*; bigger sites: fling_upload_begin \/ fling_upload_file \/ fling_upload_finish\)/,
        '(whole site; for a big site that is already on this computer, use fling_deploy with its folder)'
      ),
    },
    args =>
      run(async c => {
        const name = resolveSiteName('.', args.name)
        const tmp = await mkdtemp(join(tmpdir(), 'fling-publish-'))
        try {
          await writeInlineFiles(tmp, args.files)
          const outcome = await deployFolder(c, tmp, {
            name,
            nameGiven: true,
            spa: args.spa,
            public: args.public,
            listHtml: args.listHtml,
            retryWith: 'fling_publish',
          })
          return outcome
        } finally {
          await rm(tmp, { recursive: true, force: true })
        }
      })
  )

  server.registerTool(
    'fling_check_name',
    {
      ...toolDef(mcpTools.checkName),
      description:
        `${mcpTools.checkName.description} Pass \`path\` instead of \`name\` to see the name fling_deploy would ` +
        'generate for a file or folder on this computer (same lookup as fling_deploy), so you can confirm it with the user.',
      inputSchema: {
        name: z.string().min(1).max(200).optional().describe('Site name to check'),
        path: z
          .string()
          .optional()
          .describe('File or folder whose generated default name to check (path or file name)'),
      },
    },
    args =>
      run(async c => {
        if (args.name === undefined && args.path === undefined)
          throw new CliError('Pass `name` or `path`')
        let name = args.name
        let source: Resolved | undefined
        if (name === undefined) {
          source = await resolveInput(args.path as string, locate)
          name = defaultNameFor(source.path, source.isDirectory)
        }
        const check = await checkName(c, name)
        const base = check.status === 'invalid' ? null : await discoverSitesBase(c)
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
            ...(source
              ? { generated: true, source: { path: source.path, foundIn: source.foundIn } }
              : {}),
          },
        }
      })
  )

  let pendingLogin: { url?: string; done: Promise<LoginResult> } | undefined

  server.registerTool(
    'fling_login',
    {
      title: 'Sign in to Fling',
      description:
        'Sign the user in to Fling: opens their browser at the Fling sign-in page (Nearform Google account) and stores ' +
        'the key on this computer (shared with the fling CLI). Waits up to ~30 seconds; if sign-in is not finished by ' +
        'then, it keeps waiting in the background for up to 5 minutes — tell the user to finish signing in in the ' +
        'browser, then retry what you were doing. Call it when another tool says the user is not logged in.',
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async () => {
      try {
        const config = await store.resolve({ serverUrl: deps.server })
        if (config.apiKey && !pendingLogin) {
          const me = await whoami(
            createApiClient({
              serverUrl: config.serverUrl,
              apiKey: config.apiKey,
              fetch: fetchImpl,
            })
          ).catch(() => null)
          if (me) return textResult(`Already signed in to ${config.serverUrl} as ${me.email}.`)
        }
        if (!pendingLogin) {
          const login: { url?: string; done: Promise<LoginResult> } = {
            done: Promise.resolve() as unknown as Promise<LoginResult>,
          }
          login.done = loginFlow({
            serverUrl: config.serverUrl,
            store,
            log: silentLogger,
            open: deps.open ?? (async url => (await import('open')).default(url)),
            fetch: fetchImpl,
            timeoutMs: deps.loginTimeoutMs,
            onAuthUrl: url => {
              login.url = url
            },
          })
          login.done
            .catch(() => {})
            .finally(() => {
              if (pendingLogin === login) pendingLogin = undefined
            })
          pendingLogin = login
        }
        const current = pendingLogin
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
        return textResult(`Signed in as ${waited.r.user.email} (${waited.r.serverUrl}).`)
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: describeError(error) }] }
      }
    }
  )

  const t = mcpTools
  server.registerTool(t.list.name, toolDef(t.list), args =>
    run(async c => {
      const sites = await listSites(c, { archived: args.archived })
      return { summary: `${sites.length} site(s)`, data: { sites } }
    })
  )

  server.registerTool(t.info.name, toolDef(t.info), args =>
    run(async c => {
      const site = await getSite(c, args.name)
      return { summary: `${site.name}: ${site.url}`, data: site }
    })
  )

  server.registerTool(t.files.name, toolDef(t.files), args =>
    run(async c => {
      const result = await versionFiles(c, args.name, args.versionId)
      return {
        summary: describeVersionFiles(result.name, result, {
          current: result.current,
          url: result.url,
        }),
        data: result,
      }
    })
  )

  server.registerTool(t.share.name, toolDef(t.share), args =>
    run(async c => {
      if (args.refresh && args.revoke) throw new CliError('Use either refresh or revoke, not both')
      const result = await share(c, args.name, args)
      const summary =
        result.action === 'revoked'
          ? `Share link for ${args.name} revoked`
          : `Share link (${result.action}): ${result.shareUrl} — anyone with it can view the site`
      return { summary, data: result }
    })
  )

  server.registerTool(t.setVisibility.name, toolDef(t.setVisibility), args =>
    run(async c => {
      const site = await setVisibility(c, args.name, args.visibility)
      return { summary: `${site.name} is now ${site.visibility}: ${site.url}`, data: site }
    })
  )

  server.registerTool(t.archive.name, toolDef(t.archive), args =>
    run(async c => {
      const site = await archiveSite(c, args.name, { unarchive: args.unarchive })
      return { summary: `${site.name} ${args.unarchive ? 'restored' : 'archived'}`, data: site }
    })
  )

  server.registerTool(t.delete.name, toolDef(t.delete), args =>
    run(async c => {
      const result = await deleteSite(c, args.name)
      return { summary: `${args.name} deleted`, data: result }
    })
  )

  server.registerTool(t.rollback.name, toolDef(t.rollback), args =>
    run(async c => {
      const site = await rollback(c, args.name, args.versionId)
      return {
        summary: `${site.name} now serves version ${site.currentVersionId}: ${site.url}`,
        data: site,
      }
    })
  )

  server.registerTool(t.whoami.name, toolDef(t.whoami), () =>
    run(async c => {
      const me = await whoami(c)
      const base = await discoverSitesBase(c)
      return {
        summary: `Signed in as ${me.email} (sites are served at ${sitesPattern(base)})`,
        data: me,
      }
    })
  )

  return server
}

const textResult = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })

/** Inline files (fling_publish) → a folder: `./a` and `/a` mean `a`; no traversal, no duplicates. */
export async function writeInlineFiles(
  dir: string,
  files: readonly { path: string; content: string; encoding?: 'utf8' | 'base64' }[]
): Promise<void> {
  const seen = new Set<string>()
  let total = 0
  for (const f of files) {
    const path = f.path.replace(/^(\.\/)+/, '').replace(/^\/+/, '')
    if (!isValidSitePath(path)) throw new CliError(`Invalid file path: "${f.path}"`)
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
}

function describeError(error: unknown): string {
  if (error instanceof CliError && error.exitCode === EXIT_NOT_LOGGED_IN) return LOGIN_HINT
  if (error instanceof CliApiError && error.status === 401) return LOGIN_HINT
  if (error instanceof CliError)
    return error.hint ? `${error.message}\n${error.hint}` : error.message
  return error instanceof Error ? error.message : String(error)
}

export async function runMcpServer(deps: McpDeps = {}): Promise<void> {
  const server = createMcpServer(deps)
  await server.connect(new StdioServerTransport())
}
