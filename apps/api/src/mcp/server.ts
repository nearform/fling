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
  describeAudience,
  describeComments,
  describeGroup,
  describeGroups,
  describeNotificationSettings,
  describeRoles,
  describeSharedSite,
  describeSiteAccess,
  describeVersionFiles,
  editAudienceInput,
  editRoleInput,
  MCP_PUBLISH_MAX_BYTES,
  type McpToolDef,
  mcpRemoteInstructions,
  mcpToolsFor,
  mcpWording,
  NOT_READY_NOTE,
  needsAudience,
  preferencesUpdateOf,
  privateAudience,
  probeUrl,
  READY_TIMEOUT_LAMBDA_MS,
  readinessWaitDisabled,
  reviewUrl,
  roleLabel,
  type Site,
  shareForFeedback,
  sortSites,
  waitUntilReachable,
} from '@fling/shared'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import * as comments from '../comments.ts'
import { isAdminEmail } from '../config.ts'
import * as groups from '../groups.ts'
import { instanceMetadata, notificationChannels } from '../instance.ts'
import { ApiError } from '../lib/errors.ts'
import * as notifications from '../notifications/settings.ts'
import { canInstance, type Principal, userActor } from '../policy.ts'
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
        : `Published ${outcome.fileCount} file${outcome.fileCount === 1 ? '' : 's'}${outcome.path === undefined ? '' : ` to /${outcome.path}/ (the rest of the site kept as it was)`}`
  const extra = outcome.generatedIndex ? ' (with a generated index.html listing the pages)' : ''
  const warnings = outcome.warnings.length ? `\nWarnings:\n- ${outcome.warnings.join('\n- ')}` : ''
  const privacy = accessAfterPublish(deps, site, outcome.first === true, asked)
  const edge =
    status === 'unchanged'
      ? { ready: true, note: '' }
      : await edgeReady(deps, site.url, outcome.paths)
  const review = deps.config.comments ? reviewUrl(deps.config.appOrigin, site.name) : undefined
  const head = review
    ? `${what}${extra}.\n${shareForFeedback(review, deps.config.instanceName)}\nSite: ${site.url} (${site.access ?? site.visibility}).`
    : `${what}${extra}: ${site.url} (${site.access ?? site.visibility}).`
  return {
    text:
      `${head}${privacy}${edge.note}${warnings}` +
      `\nTo check exactly which files the site has, call fling_files with name "${site.name}".`,
    data: {
      status,
      name: site.name,
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
    },
  }
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
        notifications: notificationChannels(deps.config).length > 0,
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
    if (args.shared || !mayOwnSites) {
      const shared = sortSites(await sites.listShared(deps, user), args.sort)
      return {
        text: shared.length
          ? `${shared.length} site(s) shared with you:\n${shared.map(describeSharedSite).join('\n')}`
          : 'No sites have been shared with you.',
        data: { sites: shared },
      }
    }
    const list = sortSites(await sites.listSites(deps, user, Boolean(args.archived)), args.sort)
    const lines = list.map(s => `- ${s.name}: ${describeSite(s)}`).join('\n')
    return {
      text: list.length
        ? `${list.length} ${args.archived ? 'archived ' : ''}site(s):\n${lines}`
        : `No ${args.archived ? 'archived ' : ''}sites yet.`,
      data: { sites: list },
    }
  })

  registerSiteTool(mcpTools.info, async args => {
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
    const outcome = await publishFiles(deps, user, args.name, files, {
      principal,
      path: args.path,
      spa: args.spa,
      ...accessOf(args),
      listHtml: args.listHtml,
    })
    return publishResult(deps, args.name, outcome, 'fling_publish', args.access)
  })

  registerSiteTool(mcpTools.uploadBegin, async args => {
    const upload = await beginUpload(deps, user, args.name, {
      spa: args.spa,
      path: args.path,
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
    const outcome = await finishUpload(deps, user, args.uploadId, {
      principal,
      listHtml: args.listHtml,
    })
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
    const site = await sites.rollback(deps, user, args.name, args.versionId)
    return {
      text: `${site.name} now serves version ${site.currentVersionId}: ${site.url}`,
      data: site,
    }
  })

  if (canInstance(principal, 'account.groups.read')) {
    registerGroupTools(deps, user, principal, mcpTools, register)
  }
  if (deps.config.comments) registerCommentTools(deps, user, mcpTools, register)
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
    return {
      text: describeComments(list, {
        includeResolved: args.includeResolved,
        reviewUrl: review(list.site.name),
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
