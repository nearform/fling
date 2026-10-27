/**
 * The Fling MCP tool catalogue: names, titles, descriptions and zod input shapes shared by the
 * local server (`fling mcp`, apps/cli) and the remote connector (`POST /mcp`, apps/api), so both
 * describe the same operations the same way. Browser-safe (zod only).
 *
 * The local server reads files from disk (`fling_deploy {path}`); the remote one can't, so it takes
 * content inline (`fling_publish`, or the chunked `fling_upload_*` trio for bigger sites).
 *
 * Descriptions are templates: they name the instance, where its sites live and who can open a
 * private site. Each server renders them with `mcpToolsFor(mcpWording(instance))` — the remote one
 * from its config, the local one from the instance the CLI is logged in to.
 */
import { z } from 'zod'
import type { VersionFiles } from './api.ts'
import { AUDIENCE_EMAILS_MAX } from './audience.ts'
import {
  authorLabel,
  COMMENT_MAX_CHARS,
  type CommentList,
  commentThreads,
  reviewUrl,
} from './comments.ts'
import { SITE_NAME_MAX } from './hosts.ts'
import { type InstanceMetadata, instanceSitesPattern, privateAudience } from './instance.ts'
import { MAX_FILES } from './limits.ts'
import { SITE_SORTS } from './site-sort.ts'

/** fling_publish: total decoded bytes per call (fits a ~6 MB request once base64-encoded). */
export const MCP_PUBLISH_MAX_BYTES = 4 * 1024 * 1024
/** fling_upload_file: max `content` length (characters, as sent) per call. */
export const MCP_UPLOAD_CHUNK_MAX_CHARS = 4 * 1024 * 1024
/** Chunked uploads expire this long after fling_upload_begin. */
export const MCP_UPLOAD_TTL_SECONDS = 60 * 60
/** Files per chunked upload. */
export const MCP_UPLOAD_MAX_FILES = 1000

export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  title: string
  description: string
  inputSchema: S
  annotations: McpToolAnnotations
}

const tool = <S extends z.ZodRawShape>(def: McpToolDef<S>) => def

/** The instance-specific words in the descriptions. */
export interface McpWording {
  /** The instance's display name, e.g. "Fling". */
  name: string
  /** `https://<name>.sites.example.test` */
  sitesPattern: string
  /** Who can open a private site: "anyone signed in to Fling (@example.test accounts)". */
  privateAudience: string
  /** How the user signs in: "their Example SSO account". */
  signIn: string
  /** Where people review a site in the browser: `https://fling.example.test/review/<name>`. */
  reviewPattern: string
}

const GENERIC_REVIEW = "the site's review page in the Fling web app (/review/<name>)"

/** Wording for an instance; without one (not logged in yet) it stays generic. */
export function mcpWording(
  instance?:
    | (Pick<InstanceMetadata, 'name' | 'sitesDomain' | 'siteScheme' | 'auth'> &
        Partial<Pick<InstanceMetadata, 'appOrigin'>>)
    | null
): McpWording {
  if (!instance) {
    return {
      name: 'Fling',
      sitesPattern: 'https://<name>.<sites domain>',
      privateAudience: 'people signed in to this Fling',
      signIn: 'the Fling sign-in page',
      reviewPattern: GENERIC_REVIEW,
    }
  }
  return {
    name: instance.name,
    sitesPattern: instanceSitesPattern(instance),
    privateAudience: privateAudience(instance),
    signIn: `their ${instance.auth.displayName} account`,
    reviewPattern: instance.appOrigin ? reviewUrl(instance.appOrigin, '<name>') : GENERIC_REVIEW,
  }
}

// --- shared wording -----------------------------------------------------------------------------

const NAME_REQUIRED =
  'Publishing needs a name: if the user did not give one, propose a short descriptive one (e.g. "q3-report") ' +
  'and confirm it with them first (fling_check_name tells you whether it is free). If the name is taken by someone ' +
  'else the call fails with free suggestions — offer those to the user and retry with the one they pick.'

const INLINE_ONLY =
  'If you created the content in this conversation, pass it directly — never pass file paths from your ' +
  'sandbox (this server cannot read them) and never try to curl/upload from your sandbox.'

/** Shown to Claude wherever files are sent (no override exists, so don't let it look for one). */
export const NEVER_PUBLISHED =
  'Fling never publishes dotfiles, gitignored files, secret files (keys, certs, credentials) or files that contain ' +
  'secrets (API keys, tokens, private keys, passwords in database URLs); it stops and tells you which file and line. ' +
  'Remove the secret (or leave the file out) and retry — there is no way to override this.'

const ENCODING =
  '`encoding` is "utf8" (default, for text: HTML, CSS, JS, SVG, JSON, Markdown…) or "base64" (binary: images, fonts, PDFs).'

const LIST_HTML =
  'If the files have no root index.html but do include HTML pages, the call does not publish: it reports how ' +
  'many HTML pages there are and asks you to check with the user. Ask them whether to generate an index.html ' +
  'listing those pages (retry with `listHtml: true`) or to publish without one (`listHtml: false` — the site root ' +
  'will 404, the pages still work at their own paths), then retry.'

const listHtml = z
  .boolean()
  .optional()
  .describe(
    'Only matters when there is no root index.html: true → generate an index.html linking every HTML page; false → publish without one (root 404s). Omit until the user has decided'
  )

const siteName = z.string().min(1).max(200).describe('Site name, e.g. "q3-report"')

const sitePath = z
  .string()
  .min(1)
  .max(1024)
  .describe(
    'Site-relative path with forward slashes, e.g. "index.html", "css/app.css", "img/logo.png". The root page must be "index.html". No dotfiles (".env", ".well-known/…")'
  )

const emails = z.array(z.string().min(3).max(254)).max(AUDIENCE_EMAILS_MAX)

const commentPath = z.string().max(1024)
const commentId = z.string().min(1).max(100)

const encoding = z
  .enum(['utf8', 'base64'])
  .optional()
  .describe('How `content` is encoded: "utf8" (default) for text, "base64" for binary files')

const spa = z
  .boolean()
  .optional()
  .describe(
    'Single-page app: serve index.html for unknown paths (client-side routing). Omit to keep the current setting'
  )

// --- tools --------------------------------------------------------------------------------------

/** The catalogue, its descriptions rendered with `w`. */
export function mcpToolsFor(w: McpWording) {
  const NAME_RULES =
    `Site names are 1-${SITE_NAME_MAX} chars of lowercase letters, digits and single hyphens, and are ` +
    `one global namespace (first come, first served): the site is served at ${w.sitesPattern}.`

  const VISIBILITY =
    `Sites are private by default (only ${w.privateAudience} can open them); pass \`public: true\` only if ` +
    'the user asks for a public site. Share links (fling_share) are public to anyone who has them.'

  const isPublic = z
    .boolean()
    .optional()
    .describe(
      `true → anyone can view; false → only ${w.privateAudience}. Omit to keep the current setting (new sites are private)`
    )

  return {
    whoami: tool({
      name: 'fling_whoami',
      title: 'Who am I',
      description: `Show the signed-in user that ${w.name} acts as.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    }),

    list: tool({
      name: 'fling_list',
      title: 'List sites',
      description: "List the user's Fling sites with URL, visibility and share link.",
      inputSchema: {
        archived: z.boolean().optional().describe('List archived sites instead of live ones'),
        sort: z
          .enum(SITE_SORTS)
          .optional()
          .describe(
            'Order: updated (last updated, newest first; the default), created (newest first) or name (A–Z)'
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }),

    info: tool({
      name: 'fling_info',
      title: 'Site details',
      description:
        'Show one site: URL, visibility, share link, current version and version history (ids for fling_rollback).',
      inputSchema: { name: siteName },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }),

    files: tool({
      name: 'fling_files',
      title: 'List site files',
      description:
        "List the files in a site's current version (or in `versionId`, from fling_info): path, size and content " +
        'type, sorted by path. Use it to check what was actually published — e.g. when the user sees a 404, confirm ' +
        'the page exists at that path and that there is a root index.html (without one the site root 404s).',
      inputSchema: {
        name: siteName,
        versionId: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('Version id (from fling_info); omit for the version being served'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }),

    checkName: tool({
      name: 'fling_check_name',
      title: 'Check a site name',
      description:
        'Check whether a site name can be used before publishing: `available` (a new site), `yours` (publishing ' +
        "updates the user's existing site), `taken` (someone else's — free `suggestions` are returned) or `invalid`. " +
        NAME_RULES,
      inputSchema: { name: z.string().min(1).max(200).describe('Site name to check') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }),

    publish: tool({
      name: 'fling_publish',
      title: 'Publish a site',
      description:
        'Publish a static site to Fling in one call and get back its URL. Pass every file of the site inline in ' +
        `\`files\` (whole site, up to ${MCP_PUBLISH_MAX_BYTES / 1024 / 1024} MB decoded in total; bigger sites: ` +
        `fling_upload_begin / fling_upload_file / fling_upload_finish). ${INLINE_ONLY} ${ENCODING} ` +
        'Publishing replaces the whole site with exactly these files (it is not a patch: include unchanged files too); ' +
        'publishing identical content again is a no-op. ' +
        `${NAME_REQUIRED} ${NAME_RULES} ${VISIBILITY} ${LIST_HTML} ${NEVER_PUBLISHED} ` +
        'The result includes `warnings`. Share the returned URL with the user; fling_files shows exactly which files ' +
        'the site has.',
      inputSchema: {
        name: siteName,
        files: z
          .array(
            z.object({
              path: sitePath,
              content: z.string().describe('The file content, encoded as `encoding` says'),
              encoding,
            })
          )
          .min(1)
          .max(MAX_FILES)
          .describe('Every file of the site'),
        spa,
        public: isPublic,
        listHtml,
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }),

    uploadBegin: tool({
      name: 'fling_upload_begin',
      title: 'Start a chunked upload',
      description:
        `Start publishing a site too big for one fling_publish call (over ${MCP_PUBLISH_MAX_BYTES / 1024 / 1024} MB, ` +
        'or large binary files). Returns an `uploadId`; then send each file with fling_upload_file and finish with ' +
        `fling_upload_finish within ${MCP_UPLOAD_TTL_SECONDS / 60} minutes. ${INLINE_ONLY} ` +
        `${NAME_REQUIRED} ${VISIBILITY}`,
      inputSchema: { name: siteName, spa, public: isPublic },
      annotations: { destructiveHint: false, openWorldHint: false },
    }),

    uploadFile: tool({
      name: 'fling_upload_file',
      title: 'Upload a file (chunked)',
      description:
        'Add one file to a chunked upload started with fling_upload_begin. Sending the same path again replaces it. ' +
        `A file larger than ${MCP_UPLOAD_CHUNK_MAX_CHARS / 1024 / 1024} MB of content can span calls: send the first ` +
        'part normally, then the following parts in order with `append: true` (same path and encoding; send appends ' +
        `one at a time, not in parallel). ${ENCODING} ${NEVER_PUBLISHED}`,
      inputSchema: {
        uploadId: z.string().min(1).max(100).describe('From fling_upload_begin'),
        path: sitePath,
        content: z
          .string()
          .max(MCP_UPLOAD_CHUNK_MAX_CHARS)
          .describe('The file content (or the next part of it, with `append`)'),
        encoding,
        append: z
          .boolean()
          .optional()
          .describe('Append this content to the file sent earlier with the same path'),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    }),

    uploadFinish: tool({
      name: 'fling_upload_finish',
      title: 'Finish a chunked upload',
      description:
        'Publish everything sent with fling_upload_file as the new version of the site and return its URL. The site ' +
        `becomes exactly the uploaded files. ${LIST_HTML} The upload stays open, so just call fling_upload_finish ` +
        'again with `listHtml`. The result includes `warnings`.',
      inputSchema: {
        uploadId: z.string().min(1).max(100).describe('From fling_upload_begin'),
        listHtml,
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    }),

    share: tool({
      name: 'fling_share',
      title: 'Share link',
      description:
        'Get or create a public share link for a site: anyone with the link can view it without signing in (use it to ' +
        'show a private site to someone who cannot sign in). `refresh` replaces the link (the old one stops working); ' +
        '`revoke` removes it.',
      inputSchema: {
        name: siteName,
        refresh: z.boolean().optional().describe('Rotate the link'),
        revoke: z.boolean().optional().describe('Remove the link'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    }),

    setVisibility: tool({
      name: 'fling_set_visibility',
      title: 'Set visibility',
      description: `Make a site private (only ${w.privateAudience}) or public (anyone).`,
      inputSchema: { name: siteName, visibility: z.enum(['private', 'public']) },
      annotations: { idempotentHint: true, openWorldHint: true },
    }),

    setAudience: tool({
      name: 'fling_set_audience',
      title: 'Set who can see a private site',
      description:
        `Limit a private site to listed people (its audience), or open it again to ${w.privateAudience}. ` +
        '`add` and `remove` change the list, `set` replaces it and `clear` empties it (then every signed-in member ' +
        'can see it again). The owner always sees the site. Each address must be one that can sign in to ' +
        `${w.name}. The audience only applies while the site is private (fling_set_visibility); share links still ` +
        'open it to anyone. Removing someone takes up to 15 minutes to shut them out. fling_info shows the audience.',
      inputSchema: {
        name: siteName,
        add: emails.optional().describe('Addresses to let in'),
        remove: emails.optional().describe('Addresses to take out'),
        set: emails.optional().describe('Replace the list with exactly these addresses'),
        clear: z.boolean().optional().describe('Empty the list: every signed-in member sees it'),
      },
      annotations: { idempotentHint: true, openWorldHint: false },
    }),

    archive: tool({
      name: 'fling_archive',
      title: 'Archive or restore a site',
      description:
        'Archive a site (it stops being served and is hidden from lists, but its name, files and versions are kept) ' +
        'or, with `unarchive`, bring it back. Prefer this over deleting.',
      inputSchema: {
        name: siteName,
        unarchive: z.boolean().optional().describe('Restore an archived site'),
      },
      annotations: { idempotentHint: true, openWorldHint: false },
    }),

    delete: tool({
      name: 'fling_delete',
      title: 'Delete a site',
      description:
        'Permanently delete a site and every version of it, freeing its name. Cannot be undone — confirm with the user ' +
        'first and pass `confirm: true`. Consider fling_archive instead.',
      inputSchema: {
        name: siteName,
        confirm: z.literal(true).describe('Must be true: the user has confirmed the deletion'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    }),

    commentsList: tool({
      name: 'fling_comments_list',
      title: 'List comments',
      description:
        `List the comments people left on a site while reviewing it (${w.reviewPattern}), as threads: each ` +
        'has the page path it is about, the version the site was serving when it was written, its replies, and ' +
        `whether it is resolved. Anyone signed in to ${w.name} can comment on a site they can open. Resolved threads ` +
        'are left out unless `includeResolved`. Use it to act on feedback: fix the site, republish, then resolve ' +
        'the threads with fling_comment_resolve.',
      inputSchema: {
        name: siteName,
        path: commentPath.optional().describe('Only this page, e.g. "/" or "/docs/"'),
        includeResolved: z.boolean().optional().describe('Include resolved threads'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }),

    commentAdd: tool({
      name: 'fling_comment_add',
      title: 'Add a comment',
      description:
        `Comment on a page of a site (shown on its review page, ${w.reviewPattern}), or reply to a thread ` +
        "(`replyTo`: a thread id from fling_comments_list). Comments are signed with the user's name, so only " +
        'write one the user asked for.',
      inputSchema: {
        name: siteName,
        body: z.string().min(1).max(COMMENT_MAX_CHARS).describe('The comment (plain text)'),
        path: commentPath
          .optional()
          .describe('The page it is about (default "/"); ignored for a reply'),
        replyTo: commentId.optional().describe('Reply to this thread instead of starting one'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    }),

    commentResolve: tool({
      name: 'fling_comment_resolve',
      title: 'Resolve a comment thread',
      description:
        'Mark a comment thread resolved (e.g. after fixing what it asks for), or reopen it with `reopen: true`. ' +
        'Thread ids come from fling_comments_list.',
      inputSchema: {
        name: siteName,
        id: commentId.describe('The thread id'),
        reopen: z.boolean().optional().describe('Reopen a resolved thread'),
      },
      annotations: { idempotentHint: true, openWorldHint: false },
    }),

    commentDelete: tool({
      name: 'fling_comment_delete',
      title: 'Delete a comment',
      description:
        'Delete a comment; deleting a thread deletes its replies. People can delete their own comments, and ' +
        "a site's owner anyone's. Cannot be undone: prefer fling_comment_resolve, and confirm with the user first.",
      inputSchema: { name: siteName, id: commentId.describe('The comment id') },
      annotations: { destructiveHint: true, openWorldHint: false },
    }),

    rollback: tool({
      name: 'fling_rollback',
      title: 'Roll back',
      description:
        'Point a site at an earlier version (ids from fling_info). Instant; nothing is uploaded.',
      inputSchema: {
        name: siteName,
        versionId: z.string().min(1).max(100).describe('Version id to serve'),
      },
      annotations: { idempotentHint: true, openWorldHint: false },
    }),
  } as const
}

export type McpTools = ReturnType<typeof mcpToolsFor>

/**
 * The catalogue with generic wording: for tool names and input schemas. Servers register
 * `mcpToolsFor(mcpWording(instance))` so the descriptions name the instance.
 */
export const mcpTools: McpTools = mcpToolsFor(mcpWording())

/** Sent at `initialize` by the remote server. */
export const mcpRemoteInstructions = (w: McpWording, opts: { comments?: boolean } = {}) =>
  [
    `${w.name} publishes static sites (HTML/CSS/JS, images, documents) at ${w.sitesPattern}.`,
    'To publish content you created in this conversation (an HTML page, a report, a small app): call fling_publish with ' +
      'every file inline (text as utf8, binary as base64). This server cannot read files in your sandbox and your sandbox ' +
      'cannot reach Fling, so never pass sandbox file paths and never curl or upload from the sandbox. Make the site ' +
      'self-contained: an index.html at the root, relative links between files.',
    'Every site needs a name. If the user did not give one, propose a short descriptive name and confirm it before ' +
      'publishing (fling_check_name shows whether it is free). Names are global and first come, first served; when a ' +
      'name is taken, offer the returned suggestions.',
    `Sites are private (only ${w.privateAudience}) by default. Only make one public if asked; to show a private ` +
      'site to someone who cannot sign in, create a share link with fling_share.',
    'If a site has HTML pages but no root index.html, fling_publish / fling_upload_finish stop and ask: check with ' +
      'the user whether to generate an index.html listing the pages (`listHtml: true`) or publish without one ' +
      '(`listHtml: false`, the root URL will 404), then retry.',
    NEVER_PUBLISHED,
    `For sites over ${MCP_PUBLISH_MAX_BYTES / 1024 / 1024} MB use fling_upload_begin, fling_upload_file (repeat, ` +
      '`append` for big files) and fling_upload_finish.',
    (opts.comments
      ? 'Always give the user the links that come back: the review link first, as the one to share for feedback, then the site URL. '
      : 'Always give the user the URL that comes back. ') +
      'Use fling_list / fling_info to find existing sites, fling_rollback ' +
      'to restore a version, fling_archive rather than fling_delete unless the user insists. Use fling_files to see ' +
      'exactly which files a site has (e.g. when the user reports a 404).',
    ...(opts.comments ? [COMMENTS_NOTE(w)] : []),
  ].join('\n\n')

/** What the servers say about comments, when the instance has them. */
export const COMMENTS_NOTE = (w: McpWording) =>
  `People review sites at ${w.reviewPattern} and leave comments on its pages. Publishing returns this review link ` +
  '(`reviewUrl`): it is the one to share when the user wants feedback; reviewers sign in to use it. ' +
  'fling_comments_list shows the comments; ' +
  'after acting on feedback, resolve the threads with fling_comment_resolve. Only post (fling_comment_add) or ' +
  'delete (fling_comment_delete) comments when the user asks.'

/**
 * The line a publish result leads with when the instance has comments (both servers): the review
 * page is the link to share for feedback, and reviewers sign in to use it.
 */
export const shareForFeedback = (reviewPage: string, instanceName: string) =>
  `Share for feedback: ${reviewPage} (reviewers sign in to ${instanceName} to see the site and comment).`

/** Max files listed in a fling_files text result (structured data always has them all). */
export const MCP_FILES_LISTED = 200

/**
 * The text of a fling_files result (both servers): a header, a root-404 warning when there is no
 * index.html, then one `path (size, type)` line per file.
 */
export function describeVersionFiles(
  name: string,
  files: VersionFiles,
  opts: { current: boolean; url?: string | null }
): string {
  const kb = (n: number) =>
    n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1024 / 1024).toFixed(1)} MB`
  const n = files.files.length
  const which = opts.current ? 'current version' : 'version'
  const lines = [
    `${name} ${which} ${files.versionId}: ${n} file${n === 1 ? '' : 's'}, ${kb(files.totalBytes)}` +
      (opts.current && opts.url ? ` — served at ${opts.url}` : '') +
      (opts.current ? '' : ' (not the version being served)'),
  ]
  if (!files.files.some(f => f.path === 'index.html')) {
    lines.push(
      'Warning: there is no index.html at the root, so the site root URL returns 404 (each file still works at its own path).'
    )
  } else if (files.generatedIndex) {
    lines.push('index.html is a generated page listing the HTML pages.')
  }
  for (const f of files.files.slice(0, MCP_FILES_LISTED)) {
    lines.push(`- ${f.path} (${kb(f.size)}, ${f.contentType})`)
  }
  if (n > MCP_FILES_LISTED) lines.push(`… and ${n - MCP_FILES_LISTED} more`)
  return lines.join('\n')
}

export type McpToolName = (typeof mcpTools)[keyof typeof mcpTools]['name']

/**
 * The text of a fling_comments_list result (both servers): one block per thread — id, state, page,
 * version, author and body, then its replies indented.
 */
export function describeComments(
  list: CommentList,
  opts: { includeResolved?: boolean; reviewUrl?: string } = {}
): string {
  const all = commentThreads(list.comments)
  const threads = opts.includeResolved ? all : all.filter(t => t.comment.resolvedAt === null)
  const hidden = all.length - threads.length
  const name = list.site.name
  const version = (id: string | null) =>
    id === null ? '' : id === list.site.currentVersionId ? ', current version' : `, version ${id}`
  const head =
    `${threads.length} ${opts.includeResolved ? '' : 'open '}thread${threads.length === 1 ? '' : 's'} on ${name}` +
    (hidden ? ` (${hidden} resolved not shown)` : '') +
    (opts.reviewUrl ? `. Review page: ${opts.reviewUrl}` : '')
  const blocks = threads.map(({ comment: c, replies }) =>
    [
      `- [${c.id}] ${c.resolvedAt ? 'RESOLVED ' : ''}${c.path}${version(c.versionId)} — ${authorLabel(c.author)}, ${c.createdAt}:`,
      `  ${c.body.replace(/\n/g, '\n  ')}`,
      ...replies.map(
        r =>
          `  - [${r.id}] ${authorLabel(r.author)}, ${r.createdAt}: ${r.body.replace(/\n/g, '\n    ')}`
      ),
    ].join('\n')
  )
  return [head, ...blocks].join('\n')
}
