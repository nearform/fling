/**
 * The remote MCP server: one McpServer per request (stateless Streamable HTTP), bound to the
 * authenticated user. Tool definitions come from the shared catalogue (@fling/shared mcp-tools);
 * handlers call the site service layer directly.
 */
import {
  describeVersionFiles,
  MCP_PUBLISH_MAX_BYTES,
  MCP_REMOTE_INSTRUCTIONS,
  type McpToolDef,
  mcpTools,
  NOT_READY_NOTE,
  probeUrl,
  READY_TIMEOUT_LAMBDA_MS,
  readinessWaitDisabled,
  type Site,
  waitUntilReachable,
} from '@fling/shared'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import { ApiError } from '../lib/errors.ts'
import * as sites from '../sites.ts'
import type { User } from '../store/types.ts'
import type { Deps } from '../types.ts'
import {
  beginUpload,
  decodeContent,
  type Encoding,
  finishUpload,
  type PublishOutcome,
  publishFiles,
  uploadFile,
} from './publish.ts'

export const SERVER_VERSION = '0.1.0'

type Result = { text: string; data?: Record<string, unknown> }

/** Shape an outcome (or an error) as a tool result: text for the model + structuredContent. */
async function run(op: () => Promise<Result>): Promise<CallToolResult> {
  try {
    const { text, data } = await op()
    return {
      content: [{ type: 'text', text }],
      ...(data ? { structuredContent: data } : {}),
    }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: describeError(err) }] }
  }
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'name_taken') {
      const suggestions = (err.extra?.suggestions as string[] | undefined) ?? []
      const pick = suggestions.length ? ` Free alternatives: ${suggestions.join(', ')}.` : ''
      return (
        `Not published: ${err.message.replace(/ Try .*$/, '')}${pick} Ask the user which name to use ` +
        '(one of these or their own), then call again with that `name`.'
      )
    }
    if (err.code === 'not_found') return err.message
    return `${err.message} (${err.code})`
  }
  console.error(JSON.stringify({ level: 'error', msg: 'mcp tool failed', err: String(err) }))
  return 'Fling hit an internal error. Try again in a moment.'
}

const describeSite = (s: Site) =>
  `${s.url} (${s.visibility}${s.archived ? ', archived' : ''}${s.spa ? ', spa' : ''})` +
  (s.shareUrl ? ` — share link: ${s.shareUrl}` : '')

/** Wait (capped well inside the connector's ~10 s timeout) for the edge to route a new URL. */
async function edgeReady(deps: Deps, url: string, paths: readonly string[]) {
  let ready = true
  try {
    if (deps.waitReady) ready = (await deps.waitReady(url, paths)).ready
    else if (!readinessWaitDisabled(process.env)) {
      ready = (
        await waitUntilReachable(probeUrl(url, paths), {
          timeoutMs: READY_TIMEOUT_LAMBDA_MS,
          fetch: deps.fetch,
        })
      ).ready
    }
  } catch {
    ready = false
  }
  return { ready, note: ready ? '' : ` Not reachable yet at ${url}: ${NOT_READY_NOTE}.` }
}

async function publishResult(
  deps: Deps,
  name: string,
  outcome: PublishOutcome,
  retryWith: string
): Promise<Result> {
  if (outcome.kind === 'needs_decision') {
    const n = outcome.htmlPages.length
    const shown = outcome.htmlPages.slice(0, 20).join(', ')
    const more = n > 20 ? ` (+${n - 20} more)` : ''
    return {
      text:
        `Not published yet: there is no index.html at the root, so ${name}'s URL would 404. ` +
        `The upload has ${n} HTML page${n === 1 ? '' : 's'}: ${shown}${more}. ` +
        `Ask the user whether to generate an index.html that lists ${n === 1 ? 'it' : `these ${n} pages`} ` +
        `(call ${retryWith} again with \`listHtml: true\`) or to publish without one ` +
        `(\`listHtml: false\` — the root URL will 404 but each page works at its own path).`,
      data: {
        status: 'needs_decision',
        name,
        reason: 'no_index_html',
        htmlPages: outcome.htmlPages,
      },
    }
  }
  const { site, status } = outcome
  const what =
    status === 'unchanged'
      ? 'Unchanged — this exact content is already live'
      : status === 'repointed'
        ? `Restored previously published version ${outcome.versionId}`
        : `Published ${outcome.fileCount} file${outcome.fileCount === 1 ? '' : 's'}`
  const extra = outcome.generatedIndex ? ' (with a generated index.html listing the pages)' : ''
  const warnings = outcome.warnings.length ? `\nWarnings:\n- ${outcome.warnings.join('\n- ')}` : ''
  const privacy =
    site.visibility === 'private'
      ? ' Only signed-in Nearformers can open it; use fling_share for a public link.'
      : ''
  const edge =
    status === 'unchanged'
      ? { ready: true, note: '' }
      : await edgeReady(deps, site.url, outcome.paths)
  return {
    text:
      `${what}${extra}: ${site.url} (${site.visibility}).${privacy}${edge.note}${warnings}` +
      `\nTo check exactly which files the site has, call fling_files with name "${site.name}".`,
    data: {
      status,
      name: site.name,
      url: site.url,
      visibility: site.visibility,
      spa: site.spa,
      shareUrl: site.shareUrl,
      versionId: outcome.versionId,
      ready: edge.ready,
      fileCount: outcome.fileCount,
      totalBytes: outcome.totalBytes,
      generatedIndex: outcome.generatedIndex,
      warnings: outcome.warnings,
    },
  }
}

const visibilityOf = (pub: boolean | undefined) =>
  pub === undefined ? undefined : pub ? ('public' as const) : ('private' as const)

export function createRemoteMcpServer(deps: Deps, user: User): McpServer {
  const server = new McpServer(
    { name: 'fling', title: 'Fling', version: SERVER_VERSION },
    { instructions: MCP_REMOTE_INSTRUCTIONS }
  )

  function register<S extends z.ZodRawShape>(
    def: McpToolDef<S>,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<Result>
  ) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: { title: def.title, ...def.annotations },
      },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK's handler typing is per-shape
      ((args: any) => run(() => handler(args))) as any
    )
  }

  register(mcpTools.whoami, async () => ({
    text: `Signed in to Fling as ${user.email}. Sites are served at ${deps.config.siteScheme}://<name>.${deps.config.sitesDomain}.`,
    data: { email: user.email, name: user.name, userSlug: user.userSlug },
  }))

  register(mcpTools.list, async args => {
    const list = await sites.listSites(deps, user, Boolean(args.archived))
    const lines = list.map(s => `- ${s.name}: ${describeSite(s)}`).join('\n')
    return {
      text: list.length
        ? `${list.length} ${args.archived ? 'archived ' : ''}site(s):\n${lines}`
        : `No ${args.archived ? 'archived ' : ''}sites yet.`,
      data: { sites: list },
    }
  })

  register(mcpTools.info, async args => {
    const site = await sites.siteDetail(deps, user, args.name)
    const versions = site.versions
      .slice(0, 10)
      .map(
        v =>
          `- ${v.id}${v.id === site.currentVersionId ? ' (current)' : ''}: ${v.fileCount} files, ${v.createdAt}`
      )
      .join('\n')
    return {
      text: `${site.name}: ${describeSite(site)}\nVersions (newest first):\n${versions || '(none)'}`,
      data: site,
    }
  })

  register(mcpTools.files, async args => {
    const site = await sites.requireSite(deps, user, args.name, 'version.read')
    const versionId = args.versionId ?? site.currentVersionId
    if (!versionId)
      throw new ApiError(404, 'not_found', `${args.name} has no published version yet`)
    const files = await sites.versionFiles(deps, user, args.name, versionId)
    const current = versionId === site.currentVersionId
    const url = sites.toSite(deps, user, site).url
    return {
      text: describeVersionFiles(site.name, files, { current, url }),
      data: { name: site.name, current, ...files },
    }
  })

  register(mcpTools.checkName, async args => {
    const check = await sites.checkName(deps, user, args.name)
    const url =
      check.status === 'invalid'
        ? null
        : `${deps.config.siteScheme}://${args.name}.${deps.config.sitesDomain}/`
    const sugg = check.suggestions.length
      ? ` Free suggestions: ${check.suggestions.join(', ')}.`
      : ''
    const text = {
      available: `"${args.name}" is available → ${url}`,
      yours: `"${args.name}" is the user's existing site (${url}) — publishing replaces its content.`,
      taken: `"${args.name}" is taken by someone else.${sugg}`,
      invalid: `"${args.name}" is not a valid site name (lowercase letters, digits, single hyphens; not reserved).${sugg}`,
    }[check.status]
    return { text, data: { ...check, url } }
  })

  register(mcpTools.publish, async args => {
    let total = 0
    const files = args.files.map(f => {
      const bytes = decodeContent(f.content, (f.encoding ?? 'utf8') as Encoding, f.path)
      total += bytes.byteLength
      return { path: f.path, bytes }
    })
    if (total > MCP_PUBLISH_MAX_BYTES) {
      throw new ApiError(
        413,
        'too_large',
        `These files are ${(total / 1024 / 1024).toFixed(1)} MB; fling_publish takes up to ${MCP_PUBLISH_MAX_BYTES / 1024 / 1024} MB. Use fling_upload_begin / fling_upload_file / fling_upload_finish instead`
      )
    }
    const outcome = await publishFiles(deps, user, args.name, files, {
      spa: args.spa,
      visibility: visibilityOf(args.public),
      listHtml: args.listHtml,
    })
    return publishResult(deps, args.name, outcome, 'fling_publish')
  })

  register(mcpTools.uploadBegin, async args => {
    const upload = await beginUpload(deps, user, args.name, {
      spa: args.spa,
      visibility: visibilityOf(args.public),
    })
    return {
      text:
        `Upload ${upload.id} started for "${upload.name}". Send each file with fling_upload_file ` +
        `(uploadId "${upload.id}"), then call fling_upload_finish. Expires at ${upload.expiresAt}.`,
      data: { uploadId: upload.id, name: upload.name, expiresAt: upload.expiresAt },
    }
  })

  register(mcpTools.uploadFile, async args => {
    const res = await uploadFile(deps, user, {
      uploadId: args.uploadId,
      path: args.path,
      content: args.content,
      encoding: (args.encoding ?? 'utf8') as Encoding,
      append: args.append,
    })
    return {
      text: `Stored ${res.path}${res.part > 0 ? ` (part ${res.part + 1})` : ''}.`,
      data: res,
    }
  })

  register(mcpTools.uploadFinish, async args => {
    const upload = await deps.store.getUpload(args.uploadId)
    const outcome = await finishUpload(deps, user, args.uploadId, { listHtml: args.listHtml })
    return publishResult(deps, upload?.name ?? 'the site', outcome, 'fling_upload_finish')
  })

  register(mcpTools.share, async args => {
    if (args.refresh && args.revoke) {
      throw new ApiError(400, 'bad_request', 'Use either refresh or revoke, not both')
    }
    if (args.revoke) {
      const site = await sites.revokeShare(deps, user, args.name)
      return { text: `Share link for ${site.name} revoked.`, data: { action: 'revoked', site } }
    }
    const current = await sites.requireSite(deps, user, args.name, 'share.read')
    if (current.shareToken && !args.refresh) {
      const site = sites.toSite(deps, user, current)
      return {
        text: `Share link for ${site.name}: ${site.shareUrl} — anyone with it can view the site.`,
        data: { action: 'existing', shareUrl: site.shareUrl },
      }
    }
    const { shareUrl } = await sites.rotateShare(deps, user, args.name)
    const action = current.shareToken ? 'rotated' : 'created'
    // An archived (or never published) site isn't served, so there is nothing to wait for.
    const served =
      current.currentVersionId && !current.archived
        ? await sites
            .versionFiles(deps, user, args.name, current.currentVersionId)
            .catch(() => null)
        : null
    const edge = served
      ? await edgeReady(
          deps,
          shareUrl,
          served.files.map(f => f.path)
        )
      : { ready: true, note: '' }
    return {
      text: `Share link (${action}) for ${args.name}: ${shareUrl} — anyone with it can view the site.${edge.note}`,
      data: { action, shareUrl, ready: edge.ready },
    }
  })

  register(mcpTools.setVisibility, async args => {
    const site = await sites.updateSite(deps, user, args.name, { visibility: args.visibility })
    return { text: `${site.name} is now ${site.visibility}: ${site.url}`, data: site }
  })

  register(mcpTools.archive, async args => {
    const site = await sites.setArchived(deps, user, args.name, !args.unarchive)
    return {
      text: args.unarchive
        ? `${site.name} restored: ${site.url}`
        : `${site.name} archived (no longer served; restore with fling_archive unarchive: true).`,
      data: site,
    }
  })

  register(mcpTools.delete, async args => {
    await sites.deleteSite(deps, user, args.name)
    return {
      text: `${args.name} deleted; the name is free again.`,
      data: { name: args.name, deleted: true },
    }
  })

  register(mcpTools.rollback, async args => {
    const site = await sites.rollback(deps, user, args.name, args.versionId)
    return {
      text: `${site.name} now serves version ${site.currentVersionId}: ${site.url}`,
      data: site,
    }
  })

  return server
}
