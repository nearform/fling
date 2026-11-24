/**
 * The remote MCP server: one McpServer per request (stateless Streamable HTTP), bound to the
 * authenticated user. Tool definitions come from the shared catalogue (@fling/shared mcp-tools);
 * handlers call the site service layer directly.
 */
import {
  type AccessLevel,
  accessChangeHint,
  type Comment,
  changesAudience,
  checkFormsConfig,
  commentThreads,
  describeAudience,
  describeComments,
  describeFormsSummary,
  describeGroup,
  describeGroups,
  describeMoreSites,
  describeNotificationSettings,
  describePathDetail,
  describePaths,
  describePathsCheck,
  describePublishHints,
  describeReadFiles,
  describeResponses,
  describeRoles,
  describeServerError,
  describeServerLive,
  describeSharedSite,
  describeSiteAccess,
  describeSiteMetrics,
  describeVersionFiles,
  editAudienceInput,
  editRoleInput,
  FORMS_HINT,
  formatLogLine,
  formsSummaryLines,
  formsTemplate,
  isPathsLimitError,
  MCP_PUBLISH_MAX_BYTES,
  type McpToolDef,
  mcpRemoteInstructions,
  mcpToolsFor,
  mcpWording,
  NOT_READY_NOTE,
  needsAudience,
  normalizePathFolder,
  PATHS_LIMIT_NOTE,
  type PathsHome,
  preferencesUpdateOf,
  privateAudience,
  probeUrl,
  READY_TIMEOUT_LAMBDA_MS,
  readinessWaitDisabled,
  responsesPageUrl,
  reviewUrl,
  roleLabel,
  SERVER_CONFIG_FILE,
  SERVER_TEMPLATE,
  SERVER_TEMPLATE_CONFIG,
  type Site,
  shareForFeedback,
  waitUntilReachable,
} from '@fling/shared'
import { checkPathsIndex } from '@fling/shared/paths-index'
import { pathsTemplate } from '@fling/shared/paths-templates'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import { manifestKey } from '../blobs/types.ts'
import * as comments from '../comments.ts'
import { isAdminEmail } from '../config.ts'
import { formsOf, readForms, responsesOf } from '../forms.ts'
import * as groups from '../groups.ts'
import { instanceMetadata, notificationChannels } from '../instance.ts'
import { ApiError } from '../lib/errors.ts'
import * as notifications from '../notifications/settings.ts'
import * as paths from '../paths.ts'
import { canInstance, type Principal, userActor } from '../policy.ts'
import { siteLogs } from '../servers/api.ts'
import type { StoredManifest } from '../sites.ts'
import * as sites from '../sites.ts'
import type { User } from '../store/types.ts'
import type { Deps } from '../types.ts'
import { siteMetrics, yourSitesMetrics } from '../views.ts'
import {
  beginUpload,
  decodeContent,
  type Encoding,
  finishUpload,
  type PublishOutcome,
  publishFiles,
  uploadFile,
} from './publish.ts'
import { readFiles } from './read-files.ts'

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

/** A tool's refusal already in the words the agent needs (serverAware). */
class ToolMessage extends Error {}

/** Run a publish, rollback or upload finish, its site server's refusals said as what to do next. */
async function serverAware<T>(site: string, retryWith: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (err) {
    if (err instanceof ApiError) {
      const extra = (err.extra ?? {}) as { secrets?: string[]; logs?: string[] }
      const text = describeServerError(err.code, err.message, extra, { site, retryWith })
      if (text) throw new ToolMessage(text)
    }
    throw err
  }
}

/** Whether the instance runs site servers (the `servers` capability). */
const serversEnabled = (deps: Deps) => instanceMetadata(deps.config).capabilities.servers === true

export function describeError(err: unknown): string {
  if (err instanceof ToolMessage) return err.message
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
    if (isPathsLimitError({ code: err.code, ...err.extra })) {
      return `${err.message} (${err.code})\n${PATHS_LIMIT_NOTE}`
    }
    return `${err.message} (${err.code})`
  }
  console.error(JSON.stringify({ level: 'error', msg: 'mcp tool failed', err: String(err) }))
  return 'Fling hit an internal error. Try again in a moment.'
}

const describeSite = (s: Site) =>
  `${s.url} (${s.access ?? s.visibility}${s.archived ? ', archived' : ''}${s.spa ? ', spa' : ''})` +
  (s.role ? ` — you are ${roleLabel(s.role)}` : '') +
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

/**
 * What a publish says about who can open the site: for a new site, its access (the one asked for,
 * or the default) and how to change it; for an existing one asked for an access level, that
 * publishing left it as it was.
 */
function accessAfterPublish(
  deps: Deps,
  site: Site,
  first: boolean,
  asked: AccessLevel | undefined
): string {
  const members = privateAudience(instanceMetadata(deps.config))
  const who = describeSiteAccess(site, members)
  const hint = accessChangeHint('mcp', site.name, { invites: deps.config.invites })
  if (first) return ` Who can open it: ${who} ${hint}`
  if (asked) {
    return ` Its access is unchanged (publishing never changes it for an existing site): ${who} ${hint}`
  }
  return ''
}

async function publishResult(
  deps: Deps,
  name: string,
  outcome: PublishOutcome,
  retryWith: string,
  asked?: AccessLevel
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
        : outcome.base !== undefined
          ? `Published ${outcome.fileCount} changed or added file${outcome.fileCount === 1 ? '' : 's'} on version ${outcome.base} (the rest kept as it was) as version ${outcome.versionId}`
          : `Published ${outcome.fileCount} file${outcome.fileCount === 1 ? '' : 's'}${outcome.path === undefined ? '' : ` to the Path /${outcome.path}/ (the rest of the site untouched)`}`
  const extra = outcome.generatedIndex ? ' (with a generated index.html listing the pages)' : ''
  const warnings = outcome.warnings.length ? `\nWarnings:\n- ${outcome.warnings.join('\n- ')}` : ''
  const privacy = accessAfterPublish(deps, site, outcome.first === true, asked)
  const edge =
    status === 'unchanged'
      ? { ready: true, note: '' }
      : await edgeReady(deps, site.url, outcome.paths)
  const review = deps.config.comments ? reviewUrl(deps.config.appOrigin, site.name) : undefined
  const forms = formsEnabled(deps)
    ? await formsAfterPublish(deps, site.name, outcome.versionId)
    : null
  const head = review
    ? `${what}${extra}.\n${shareForFeedback(review, deps.config.instanceName, Boolean(forms?.summary))}\nSite: ${site.url} (${site.access ?? site.visibility}).`
    : `${what}${extra}: ${site.url} (${site.access ?? site.visibility}).`
  const formsText = forms?.summary
    ? `\n${describeFormsSummary(forms.summary, forms.responsesPage)}`
    : ''
  const serverText =
    site.hasServer && status !== 'unchanged'
      ? describeServerLive({
          name: site.name,
          secrets: await liveSecrets(deps, site.name),
          egress: deps.config.servers.egress,
        })
      : ''
  return {
    text:
      `${head}${formsText}${serverText}${privacy}${edge.note}${warnings}${describePublishHints(outcome.hints)}` +
      `\nTo check exactly which files the site has, call fling_files with name "${site.name}".` +
      (forms && !forms.summary ? `\n${FORMS_HINT}` : ''),
    data: {
      status,
      name: site.name,
      ...(outcome.hints?.length ? { hints: outcome.hints } : {}),
      url: site.url,
      ...(review ? { reviewUrl: review } : {}),
      visibility: site.visibility,
      access: site.access,
      ...(outcome.first ? { created: true } : {}),
      spa: site.spa,
      shareUrl: site.shareUrl,
      versionId: outcome.versionId,
      ...(outcome.path === undefined ? {} : { path: outcome.path }),
      ready: edge.ready,
      fileCount: outcome.fileCount,
      totalBytes: outcome.totalBytes,
      generatedIndex: outcome.generatedIndex,
      warnings: outcome.warnings,
      ...(forms?.summary
        ? {
            forms: {
              title: forms.summary.title,
              forms: forms.summary.forms,
              summary: formsSummaryLines(forms.summary),
              responsesUrl: forms.responsesPage,
            },
          }
        : forms
          ? { formsHint: FORMS_HINT }
          : {}),
    },
  }
}

/** The secrets the site's live version declares (its `fling.json`), for the publish result. */
async function liveSecrets(deps: Deps, name: string): Promise<string[]> {
  const site = await deps.store.findSite(name)
  if (!site?.currentVersionId) return []
  const version = await deps.store.getVersion(site, site.currentVersionId)
  return version?.server?.secrets ?? []
}

/** Whether the instance has forms (the `forms` capability). */
const formsEnabled = (deps: Deps) => instanceMetadata(deps.config).capabilities.forms === true

/**
 * The forms a publish left on its version, summarised against the version's pages (null summary:
 * it has none).
 */
async function formsAfterPublish(deps: Deps, name: string, versionId: string) {
  const responsesPage = responsesPageUrl(deps.config.appOrigin, name)
  const record = await deps.store.findSite(name)
  const config = record ? await readForms(deps, record.id, versionId) : null
  if (!record || !config) return { summary: null, responsesPage }
  const manifest = await deps.blobs.getJson<StoredManifest>(manifestKey(record.id, versionId))
  const check = checkFormsConfig(
    config,
    (manifest?.files ?? []).map(f => f.path)
  )
  return { summary: check.summary, responsesPage }
}

/** A Path's folder as a tool was given it, normalised; 400 unless it is one top-level folder. */
function folderOf(raw: string): string {
  const folder = normalizePathFolder(raw)
  if (folder === null) {
    throw new ApiError(
      400,
      'bad_request',
      `"${raw}" is not a Path: give one top-level folder of the site, like "PAY-412"`
    )
  }
  return folder
}

/**
 * What the site's home page does with its Paths, from its current version (rendering.ts): a Paths
 * block, no home page (the default listing) or its own page without a block. Undefined without a
 * current version. Only called once the caller may see the site.
 */
async function pathsHomeOf(deps: Deps, name: string): Promise<PathsHome | undefined> {
  const site = await deps.store.findSite(name)
  if (!site?.currentVersionId) return undefined
  const version = await deps.store.getVersion(site, site.currentVersionId)
  if (!version) return undefined
  if (version.home === 'block') return 'block'
  if (version.home === 'none') return 'default'
  // Versions published before the home page was recorded: whether they have an index.html.
  const manifest = await deps.blobs.getJson<StoredManifest>(
    manifestKey(site.id, site.currentVersionId)
  )
  if (!manifest) return undefined
  return manifest.files.some(f => f.path === 'index.html') ? 'own' : undefined
}

const visibilityOf = (pub: boolean | undefined) =>
  pub === undefined ? undefined : pub ? ('public' as const) : ('private' as const)

/**
 * A publish's access choice, for the API: the level, its audience for groups and people, and the
 * older `public` only when no level is given.
 */
function accessOf(args: {
  access?: AccessLevel
  emails?: string[]
  groups?: string[]
  public?: boolean
}) {
  if (args.access === undefined) return { visibility: visibilityOf(args.public) }
  return {
    access: args.access,
    ...(needsAudience(args.access)
      ? { audience: { emails: args.emails ?? [], groups: args.groups ?? [] } }
      : {}),
  }
}

/**
 * The tools `user` may use. A guest (`principal`) gets only what reviewing takes: who they are,
 * the sites shared with them, comments and their notification settings; no site, publishing or
 * group tools.
 */
export function createRemoteMcpServer(deps: Deps, user: User, principal: Principal): McpServer {
  const wording = mcpWording(instanceMetadata(deps.config))
  const members = privateAudience(instanceMetadata(deps.config))
  const mcpTools = mcpToolsFor(wording)
  const server = new McpServer(
    { name: 'fling', title: deps.config.instanceName, version: SERVER_VERSION },
    {
      instructions: mcpRemoteInstructions(wording, {
        comments: deps.config.comments,
        forms: formsEnabled(deps),
        notifications: notificationChannels(deps.config).length > 0,
        servers: serversEnabled(deps),
      }),
    }
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

  const mayOwnSites = canInstance(principal, 'account.site.create')
  /** Registers the tools about one's own sites, for anyone but a guest. */
  const registerSiteTool: typeof register = (def, handler) => {
    if (mayOwnSites) register(def, handler)
  }

  register(mcpTools.list, async args => {
    const page = {
      sort: args.sort,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
    }
    const paged = args.limit !== undefined
    if (args.shared || !mayOwnSites) {
      const { sites: shared, cursor } = await sites.listShared(deps, user, page)
      return {
        text:
          (shared.length
            ? `${shared.length} site(s) shared with you${paged ? ' on this page' : ''}:\n${shared.map(describeSharedSite).join('\n')}`
            : paged
              ? 'No more sites shared with you.'
              : 'No sites have been shared with you.') + describeMoreSites(cursor),
        data: { sites: shared, ...(paged ? { cursor: cursor ?? null } : {}) },
      }
    }
    const { sites: list, cursor } = await sites.listSites(deps, user, Boolean(args.archived), page)
    const lines = list.map(s => `- ${s.name}: ${describeSite(s)}`).join('\n')
    const kind = args.archived ? 'archived ' : ''
    return {
      text:
        (list.length
          ? `${list.length} ${kind}site(s)${paged ? ' on this page' : ''}:\n${lines}`
          : paged
            ? `No more ${kind}sites.`
            : `No ${kind}sites yet.`) + describeMoreSites(cursor),
      data: { sites: list, ...(paged ? { cursor: cursor ?? null } : {}) },
    }
  })

  registerSiteTool(mcpTools.info, async args => {
    if (args.path !== undefined) {
      const path = await paths.pathDetail(deps, user, args.name, folderOf(args.path))
      return { text: describePathDetail(args.name, path), data: { name: args.name, ...path } }
    }
    const site = await sites.siteDetail(deps, user, args.name)
    const versions = site.versions
      .slice(0, 10)
      .map(
        v =>
          `- ${v.id}${v.id === site.currentVersionId ? ' (current)' : ''}: ${v.fileCount} files, ${v.createdAt}${v.publishedBy ? `, by ${v.publishedBy}` : ''}${v.path ? `, to /${v.path}/` : ''}`
      )
      .join('\n')
    return {
      text:
        `${site.name}: ${describeSite(site)}\n${describeAudience(site, members)}\n` +
        `${describeRoles(site)}\n` +
        `Versions (newest first):\n${versions || '(none)'}`,
      data: site,
    }
  })

  registerSiteTool(mcpTools.files, async args => {
    if (args.path !== undefined) {
      const folder = folderOf(args.path)
      const found = await paths.requirePath(deps, user, args.name, folder, 'version.read')
      const versionId = args.versionId ?? found.path.currentVersionId
      if (!versionId) {
        throw new ApiError(404, 'not_found', `/${folder}/ of ${args.name} has no version yet`)
      }
      const files = await paths.pathVersionFiles(deps, user, args.name, folder, versionId)
      const current = versionId === found.path.currentVersionId
      const url = `${sites.toSite(deps, found.siteActor, found.site).url}${encodeURIComponent(folder)}/`
      return {
        text: describeVersionFiles(`${found.site.name} /${folder}/`, files, { current, url }),
        data: { name: found.site.name, path: folder, current, ...files },
      }
    }
    const { site, actor } = await sites.requireSiteAs(deps, user, args.name, 'version.read')
    const versionId = args.versionId ?? site.currentVersionId
    if (!versionId)
      throw new ApiError(404, 'not_found', `${args.name} has no published version yet`)
    const files = await sites.versionFiles(deps, user, args.name, versionId)
    const current = versionId === site.currentVersionId
    const url = sites.toSite(deps, actor, site).url
    return {
      text: describeVersionFiles(site.name, files, { current, url }),
      data: { name: site.name, current, ...files },
    }
  })

  registerSiteTool(mcpTools.readFiles, async args => {
    const read = await readFiles(deps, user, args.name, {
      versionId: args.versionId,
      path: args.path,
      paths: args.paths,
      cursor: args.cursor,
    })
    const data = {
      name: read.name,
      versionId: read.versionId,
      files: read.files,
      missing: read.missing,
      ...(read.nextCursor ? { nextCursor: read.nextCursor } : {}),
      ...(read.server ? { server: read.server } : {}),
    }
    // The contents go in the text too: some clients show the model only the text.
    return {
      text: `${describeReadFiles(read.name, read)}\n\n${JSON.stringify(data)}`,
      data,
    }
  })

  registerSiteTool(mcpTools.checkName, async args => {
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

  registerSiteTool(mcpTools.publish, async args => {
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
    const outcome = await serverAware(args.name, 'fling_publish', () =>
      publishFiles(deps, user, args.name, files, {
        principal,
        path: args.path,
        base: args.base,
        remove: args.remove,
        spa: args.spa,
        ...accessOf(args),
        listHtml: args.listHtml,
        ...(args.forms === undefined ? {} : { forms: args.forms }),
        ...(args.siteServer === undefined ? {} : { server: args.siteServer }),
        ...(args.confirmPublicServer ? { confirmPublicServer: true } : {}),
      })
    )
    return publishResult(deps, args.name, outcome, 'fling_publish', args.access)
  })

  registerSiteTool(mcpTools.uploadBegin, async args => {
    const upload = await beginUpload(deps, user, args.name, {
      spa: args.spa,
      path: args.path,
      base: args.base,
      remove: args.remove,
      ...accessOf(args),
    })
    return {
      text:
        `Upload ${upload.id} started for "${upload.name}"${upload.path ? `, into /${upload.path}/` : ''}. Send each file with fling_upload_file ` +
        `(uploadId "${upload.id}"), then call fling_upload_finish. Expires at ${upload.expiresAt}.`,
      data: { uploadId: upload.id, name: upload.name, expiresAt: upload.expiresAt },
    }
  })

  registerSiteTool(mcpTools.uploadFile, async args => {
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

  registerSiteTool(mcpTools.uploadFinish, async args => {
    const upload = await deps.store.getUpload(args.uploadId)
    const outcome = await serverAware(upload?.name ?? 'the site', 'fling_upload_finish', () =>
      finishUpload(deps, user, args.uploadId, {
        principal,
        listHtml: args.listHtml,
        ...(args.confirmPublicServer ? { confirmPublicServer: true } : {}),
      })
    )
    return publishResult(
      deps,
      upload?.name ?? 'the site',
      outcome,
      'fling_upload_finish',
      upload?.access
    )
  })

  registerSiteTool(mcpTools.share, async args => {
    if (args.refresh && args.revoke) {
      throw new ApiError(400, 'bad_request', 'Use either refresh or revoke, not both')
    }
    if (args.revoke) {
      const site = await sites.revokeShare(deps, user, args.name)
      return { text: `Share link for ${site.name} revoked.`, data: { action: 'revoked', site } }
    }
    const { site: current, actor } = await sites.requireSiteAs(deps, user, args.name, 'share.read')
    if (current.shareToken && !args.refresh) {
      const site = sites.toSite(deps, actor, current)
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

  registerSiteTool(mcpTools.setAccess, async args => {
    const site = await sites.updateSite(
      deps,
      user,
      args.name,
      {
        access: args.access,
        ...(needsAudience(args.access)
          ? { audience: { emails: args.emails ?? [], groups: args.groups ?? [] } }
          : {}),
      },
      principal
    )
    return { text: `${site.name}: ${describeAudience(site, members)}`, data: site }
  })

  registerSiteTool(mcpTools.setVisibility, async args => {
    const site = await sites.updateSite(
      deps,
      user,
      args.name,
      { visibility: args.visibility },
      principal
    )
    return { text: `${site.name} is now ${site.visibility}: ${site.url}`, data: site }
  })

  registerSiteTool(mcpTools.setAudience, async args => {
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
      throw new ApiError(
        400,
        'bad_request',
        'Pass `add`, `remove`, `set`, `addGroups`, `removeGroups`, `setGroups` or `clear`'
      )
    }
    // Reading the audience to edit it; updateSite asks for site.audience.
    const current = await sites.requireSite(deps, user, args.name, 'site.read')
    const site = await sites.updateSite(
      deps,
      user,
      args.name,
      { audience: editAudienceInput(await sites.audienceOf(deps, current), change) },
      principal
    )
    return { text: `${site.name}: ${describeAudience(site, members)}`, data: site }
  })

  for (const [def, which] of [
    [mcpTools.setOwners, 'owners'],
    [mcpTools.setPublishers, 'publishers'],
  ] as const) {
    registerSiteTool(def, async args => {
      const change = {
        add: args.add,
        remove: args.remove,
        set: args.set,
        addGroups: args.addGroups,
        removeGroups: args.removeGroups,
        setGroups: args.setGroups,
      }
      if (!changesAudience(change)) {
        throw new ApiError(
          400,
          'bad_request',
          'Pass `add`, `remove`, `set`, `addGroups`, `removeGroups` or `setGroups`'
        )
      }
      // Reading the list to edit it; updateSite asks for site.owners or site.publishers.
      const current = await sites.requireSite(deps, user, args.name, 'site.read')
      const roles = await sites.rolesView(deps, current)
      const site = await sites.updateSite(
        deps,
        user,
        args.name,
        { [which]: editRoleInput(roles[which], change) },
        principal
      )
      return { text: `${site.name}: ${describeRoles(site)}`, data: site }
    })
  }

  registerSiteTool(mcpTools.archive, async args => {
    const site = await sites.setArchived(deps, user, args.name, !args.unarchive)
    return {
      text: args.unarchive
        ? `${site.name} restored: ${site.url}`
        : `${site.name} archived (no longer served; restore with fling_archive unarchive: true).`,
      data: site,
    }
  })

  registerSiteTool(mcpTools.delete, async args => {
    await sites.deleteSite(deps, user, args.name)
    return {
      text: `${args.name} deleted; the name is free again.`,
      data: { name: args.name, deleted: true },
    }
  })

  registerSiteTool(mcpTools.rollback, async args => {
    if (args.path !== undefined) {
      const folder = folderOf(args.path)
      const path = await paths.rollbackPath(deps, user, args.name, folder, args.versionId)
      return {
        text: `/${folder}/ of ${args.name} now serves version ${path.currentVersionId}: ${path.url} (the rest of the site untouched)`,
        data: { name: args.name, ...path },
      }
    }
    const site = await serverAware(args.name, 'fling_rollback', () =>
      sites.rollback(deps, user, args.name, args.versionId)
    )
    return {
      text: `${site.name} now serves version ${site.currentVersionId}: ${site.url}`,
      data: site,
    }
  })

  if (instanceMetadata(deps.config).capabilities.metrics === true) {
    registerSiteTool(mcpTools.stats, async args => {
      const metrics =
        args.name === undefined
          ? await yourSitesMetrics(deps, user)
          : await siteMetrics(deps, user, args.name)
      return { text: describeSiteMetrics(metrics, deps.config.instanceName), data: metrics }
    })
  }

  if (instanceMetadata(deps.config).capabilities.paths === true) {
    registerSiteTool(mcpTools.paths, async args => {
      const list = await paths.listPathsOf(deps, user, args.name)
      const home = await pathsHomeOf(deps, args.name)
      return {
        text: describePaths(args.name, list, { home }),
        data: { name: args.name, paths: list, ...(home ? { home } : {}) },
      }
    })

    registerSiteTool(mcpTools.pathsTemplate, async args => {
      const html = pathsTemplate(args.template, { title: args.title })
      return {
        text:
          `A starter "${args.template}" home page with its Paths block in place. Adapt it to what the user wants ` +
          "while keeping the block, check it with fling_paths_check, then publish it as the site's root " +
          `index.html (without \`path\`).\n\n${html}`,
        data: { template: args.template, html },
      }
    })

    registerSiteTool(mcpTools.pathsCheck, async args => {
      const check = checkPathsIndex(args.html)
      return { text: describePathsCheck(check), data: { ...check } }
    })
  }

  if (serversEnabled(deps)) {
    registerSiteTool(mcpTools.logs, async args => {
      const lines = await siteLogs(deps, user, args.name, {
        ...(args.since ? { since: args.since } : {}),
      })
      return {
        text: lines.length
          ? `${args.name}'s server log since ${args.since ?? '1h'} ago (${lines.length} line${lines.length === 1 ? '' : 's'}, oldest first):\n${lines.map(formatLogLine).join('\n')}`
          : `No log lines for ${args.name} since ${args.since ?? '1h'} ago.`,
        data: { name: args.name, lines },
      }
    })

    registerSiteTool(mcpTools.serverTemplate, async () => ({
      text:
        'A dependency-free site server to start from. Add the routes the site needs to its table (plain ' +
        'JavaScript, no npm packages: a remote publish takes the server as one file), then call fling_publish with ' +
        `the site's pages plus these two files: _fling/server.mjs and ${SERVER_CONFIG_FILE} (add the names of any ` +
        'site secrets it reads to "secrets"; the user sets their values, never the conversation).\n\n' +
        `_fling/server.mjs:\n${SERVER_TEMPLATE}\n${SERVER_CONFIG_FILE}:\n${JSON.stringify(SERVER_TEMPLATE_CONFIG, null, 2)}`,
      data: {
        files: [
          { path: '_fling/server.mjs', content: SERVER_TEMPLATE },
          {
            path: SERVER_CONFIG_FILE,
            content: `${JSON.stringify(SERVER_TEMPLATE_CONFIG, null, 2)}\n`,
          },
        ],
      },
    }))
  }

  if (canInstance(principal, 'account.groups.read')) {
    registerGroupTools(deps, user, principal, mcpTools, register)
  }
  if (deps.config.comments) registerCommentTools(deps, user, mcpTools, register)
  if (formsEnabled(deps)) registerFormTools(deps, user, mcpTools, register)
  if (notificationChannels(deps.config).length > 0) {
    registerNotificationTools(deps, user, mcpTools, register)
  }

  return server
}

/** The group tools (the `groups` capability, which every instance has). */
function registerGroupTools(
  deps: Deps,
  user: User,
  principal: Principal,
  mcpTools: ReturnType<typeof mcpToolsFor>,
  register: <S extends z.ZodRawShape>(
    def: McpToolDef<S>,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<Result>
  ) => void
) {
  register(mcpTools.groups, async args => {
    const list = await groups.listGroups(deps, user, { mine: args.mine, members: args.members })
    return {
      text: list.length
        ? `${list.length} ${args.mine ? 'of your ' : ''}group(s)${args.members ? ' of exactly those people' : ''}:\n${describeGroups(list, user.email)}`
        : args.members
          ? 'No group has exactly those people.'
          : args.mine
            ? 'You have no groups yet.'
            : 'No groups yet.',
      data: { groups: list },
    }
  })

  register(mcpTools.groupShow, async args => {
    const group = await groups.groupDetail(deps, user, args.slug)
    return { text: describeGroup(group), data: group }
  })

  register(mcpTools.groupCreate, async args => {
    const group = await groups.createGroup(
      deps,
      user,
      {
        slug: args.slug,
        name: args.name,
        members: args.members,
      },
      principal
    )
    return { text: `Created ${describeGroup(group)}`, data: group }
  })

  register(mcpTools.groupMembers, async args => {
    if (!args.add?.length && !args.remove?.length) {
      throw new ApiError(400, 'bad_request', 'Pass `add` or `remove`')
    }
    const group = await groups.changeMembers(
      deps,
      user,
      args.slug,
      { add: args.add, remove: args.remove },
      principal
    )
    return { text: describeGroup(group), data: group }
  })

  register(mcpTools.groupRename, async args => {
    const group = await groups.renameGroup(deps, user, args.slug, args.name)
    return { text: describeGroup(group), data: group }
  })

  register(mcpTools.groupDelete, async args => {
    await groups.deleteGroup(deps, user, args.slug)
    return {
      text: `Group ${args.slug} deleted. Sites whose audience named it keep their restriction: anyone it let in has lost access.`,
      data: { slug: args.slug, deleted: true },
    }
  })
}

/** Comments of open threads only (a resolved thread's replies go with it). */
function openOnly(all: Comment[]) {
  const resolved = new Set(all.filter(c => c.resolvedAt !== null).map(c => c.id))
  return all.filter(c => !resolved.has(c.parentId ?? c.id))
}

/** The comment tools: only on an instance with comments (the `comments` capability). */
function registerCommentTools(
  deps: Deps,
  user: User,
  mcpTools: ReturnType<typeof mcpToolsFor>,
  register: <S extends z.ZodRawShape>(
    def: McpToolDef<S>,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<Result>
  ) => void
) {
  const actor = userActor(user)
  const review = (name: string) => reviewUrl(deps.config.appOrigin, name)

  register(mcpTools.commentsList, async args => {
    const list = await comments.listComments(deps, actor, args.name, { path: args.path })
    // Only worth a look when the threads could be coded labels and the site has no forms to use.
    const suggestForms =
      formsEnabled(deps) &&
      commentThreads(list.comments).length >= 5 &&
      !(await comments
        .commentSite(deps, actor, args.name, 'comment.read')
        .then(({ site }) => readForms(deps, site.id, site.currentVersionId)))
    return {
      text: describeComments(list, {
        includeResolved: args.includeResolved,
        reviewUrl: review(list.site.name),
        suggestForms,
      }),
      data: {
        ...list,
        comments: args.includeResolved ? list.comments : openOnly(list.comments),
        reviewUrl: review(list.site.name),
      },
    }
  })

  register(mcpTools.commentAdd, async args => {
    const comment = await comments.addComment(deps, actor, args.name, {
      body: args.body,
      path: args.path,
      parentId: args.replyTo,
    })
    const what = comment.parentId ? `Replied to thread ${comment.parentId}` : 'Comment added'
    return {
      text: `${what} on ${args.name} (${comment.path}, id ${comment.id}). Review page: ${review(args.name)}`,
      data: { ...comment, reviewUrl: review(args.name) },
    }
  })

  register(mcpTools.commentResolve, async args => {
    const comment = await comments.resolveComment(deps, actor, args.name, args.id, !args.reopen)
    return {
      text: `Thread ${comment.id} on ${args.name} ${args.reopen ? 'reopened' : 'resolved'}.`,
      data: comment,
    }
  })

  register(mcpTools.commentDelete, async args => {
    await comments.deleteComment(deps, actor, args.name, args.id)
    return {
      text: `Comment ${args.id} on ${args.name} deleted.`,
      data: { name: args.name, id: args.id, deleted: true },
    }
  })
}

/** The notification tools: only with a channel on (the `notifications` capability). */
function registerNotificationTools(
  deps: Deps,
  user: User,
  mcpTools: ReturnType<typeof mcpToolsFor>,
  register: <S extends z.ZodRawShape>(
    def: McpToolDef<S>,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<Result>
  ) => void
) {
  register(mcpTools.notifications, async () => {
    const settings = await notifications.getNotificationSettings(deps, user.email)
    return { text: describeNotificationSettings(settings), data: settings }
  })

  register(mcpTools.notificationsSet, async args => {
    if (args.muted === undefined && !args.cells?.length) {
      throw new ApiError(400, 'bad_request', 'Pass `muted` or `cells`')
    }
    // /mcp takes API keys and OAuth tokens, never a session, so it never acts for an impersonator.
    const settings = await notifications.updateNotificationSettings(
      deps,
      {
        email: user.email,
        admin: isAdminEmail(deps.config, user.email),
        via: 'oauth',
        guest: user.guest === true,
      },
      preferencesUpdateOf(args)
    )
    return { text: `Saved.\n${describeNotificationSettings(settings)}`, data: settings }
  })
}

/** The forms tools: only on an instance with forms (the `forms` capability, on with comments). */
function registerFormTools(
  deps: Deps,
  user: User,
  mcpTools: ReturnType<typeof mcpToolsFor>,
  register: <S extends z.ZodRawShape>(
    def: McpToolDef<S>,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<Result>
  ) => void
) {
  const actor = userActor(user)
  const review = (name: string, path?: string) => reviewUrl(deps.config.appOrigin, name, path)
  const responsesPage = (name: string) => responsesPageUrl(deps.config.appOrigin, name)

  register(mcpTools.forms, async args => {
    const { site } = await comments.commentSite(deps, actor, args.name, 'comment.read')
    const forms = await formsOf(deps, site, args.path)
    if (!forms.config) {
      return {
        text: `${site.name} has no forms on its live version. ${FORMS_HINT}`,
        data: { name: site.name, ...forms },
      }
    }
    const manifest = site.currentVersionId
      ? await deps.blobs.getJson<StoredManifest>(manifestKey(site.id, site.currentVersionId))
      : null
    const check = checkFormsConfig(
      forms.config,
      (manifest?.files ?? []).map(f => f.path)
    )
    const lines = check.summary ? formsSummaryLines(check.summary).map(l => `- ${l}`) : []
    return {
      text:
        `${forms.config.title} on ${site.name}${forms.path ? ` (forms on ${forms.path}: ${forms.forms.map(f => f.id).join(', ') || 'none'})` : ''}:\n` +
        `${lines.join('\n')}\nResponses and progress: ${responsesPage(site.name)}\n\n${JSON.stringify(forms.config)}`,
      data: { name: site.name, ...forms, responsesUrl: responsesPage(site.name) },
    }
  })

  register(mcpTools.formsTemplate, async args => {
    const config = formsTemplate(args.template, args.title)
    return {
      text:
        `A starter "${args.template}" config. Adapt its options, wording and \`paths\` to what the user wants ` +
        `collected, check it with fling_forms_check, then publish it as \`forms\`.\n\n${JSON.stringify(config, null, 2)}`,
      data: { template: args.template, forms: config },
    }
  })

  register(mcpTools.formsCheck, async args => {
    const check = checkFormsConfig(args.forms, args.paths)
    const lines = check.summary ? formsSummaryLines(check.summary).map(l => `- ${l}`) : []
    return {
      text: check.ok
        ? `The forms config is valid.${lines.length ? `\n${lines.join('\n')}` : ''}`
        : `The forms config is not valid:\n${check.errors.map(e => `- ${e}`).join('\n')}`,
      data: { ...check },
    }
  })

  register(mcpTools.responsesList, async args => {
    const { site, actor: who } = await comments.commentSite(deps, actor, args.name, 'comment.read')
    const exported = await responsesOf(deps, who, site, {
      ...(args.form ? { form: args.form } : {}),
      ...(args.path !== undefined ? { path: args.path } : {}),
    })
    const data = { ...exported, responsesUrl: responsesPage(site.name) }
    return {
      text: `${describeResponses(exported, { responsesPage: responsesPage(site.name) })}\n\n${JSON.stringify(data)}`,
      data,
    }
  })

  register(mcpTools.responseSubmit, async args => {
    const comment = await comments.addComment(deps, actor, args.name, {
      path: args.path,
      ...(args.quote ? { anchor: { x: 0, y: 0, quote: args.quote } } : {}),
      response: { formId: args.formId, data: args.data },
    })
    return {
      text: `Answered "${args.formId}" on ${args.name} ${comment.path} (id ${comment.id}).\n${comment.body}\nReview page: ${review(args.name, comment.path)}`,
      data: { ...comment, reviewUrl: review(args.name, comment.path) },
    }
  })
}
