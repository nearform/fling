/**
 * The Fling MCP tool catalogue: names, titles, descriptions and zod input shapes shared by the
 * local server (`fling mcp`, apps/cli) and the remote connector (`POST /mcp`, apps/api), so both
 * describe the same operations the same way. Browser-safe (zod only).
 *
 * The local server reads files from disk (`fling_deploy {path}`); the remote one can't, so it takes
 * content inline (`fling_publish`, or the chunked `fling_upload_*` trio for bigger sites).
 */
import { z } from 'zod'
import { SITE_NAME_MAX } from './hosts.ts'
import { MAX_FILES } from './limits.ts'

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

// --- shared wording -----------------------------------------------------------------------------

const NAME_RULES =
  `Site names are 1-${SITE_NAME_MAX} chars of lowercase letters, digits and single hyphens, and are ` +
  'one global namespace (first come, first served): the site is served at https://<name>.fling.labs.nearform.com.'

const NAME_REQUIRED =
  'Publishing needs a name: if the user did not give one, propose a short descriptive one (e.g. "q3-report") ' +
  'and confirm it with them first (fling_check_name tells you whether it is free). If the name is taken by someone ' +
  'else the call fails with free suggestions — offer those to the user and retry with the one they pick.'

const VISIBILITY =
  'Sites are private by default (only signed-in Nearformers can open them); pass `public: true` only if the ' +
  'user asks for a public site. Share links (fling_share) are public to anyone who has them.'

const INLINE_ONLY =
  'If you created the content in this conversation, pass it directly — never pass file paths from your ' +
  'sandbox (this server cannot read them) and never try to curl/upload from your sandbox.'

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
    'Site-relative path with forward slashes, e.g. "index.html", "css/app.css", "img/logo.png". The root page must be "index.html".'
  )

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

const isPublic = z
  .boolean()
  .optional()
  .describe(
    'true → anyone can view; false → Nearformers only. Omit to keep the current setting (new sites are private)'
  )

// --- tools --------------------------------------------------------------------------------------

export const mcpTools = {
  whoami: tool({
    name: 'fling_whoami',
    title: 'Who am I',
    description: 'Show the signed-in Nearform user that Fling acts as.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }),

  list: tool({
    name: 'fling_list',
    title: 'List sites',
    description: "List the user's Fling sites with URL, visibility and share link.",
    inputSchema: {
      archived: z.boolean().optional().describe('List archived sites instead of live ones'),
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
      `${NAME_REQUIRED} ${NAME_RULES} ${VISIBILITY} ${LIST_HTML} ` +
      'The result includes `warnings`. Share the returned URL with the user.',
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
      `one at a time, not in parallel). ${ENCODING}`,
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
      'show a private site to someone outside Nearform). `refresh` replaces the link (the old one stops working); ' +
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
    description: 'Make a site private (signed-in Nearformers only) or public (anyone).',
    inputSchema: { name: siteName, visibility: z.enum(['private', 'public']) },
    annotations: { idempotentHint: true, openWorldHint: true },
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

/** Sent at `initialize` by the remote server. */
export const MCP_REMOTE_INSTRUCTIONS = [
  'Fling publishes static sites (HTML/CSS/JS, images, documents) for Nearform staff at https://<name>.fling.labs.nearform.com.',
  'To publish content you created in this conversation (an HTML page, a report, a small app): call fling_publish with ' +
    'every file inline (text as utf8, binary as base64). This server cannot read files in your sandbox and your sandbox ' +
    'cannot reach Fling, so never pass sandbox file paths and never curl or upload from the sandbox. Make the site ' +
    'self-contained: an index.html at the root, relative links between files.',
  'Every site needs a name. If the user did not give one, propose a short descriptive name and confirm it before ' +
    'publishing (fling_check_name shows whether it is free). Names are global and first come, first served; when a ' +
    'name is taken, offer the returned suggestions.',
  'Sites are private (Nearformers only) by default. Only make one public if asked; to show a private site to someone ' +
    'outside Nearform, create a share link with fling_share.',
  'If a site has HTML pages but no root index.html, fling_publish / fling_upload_finish stop and ask: check with ' +
    'the user whether to generate an index.html listing the pages (`listHtml: true`) or publish without one ' +
    '(`listHtml: false`, the root URL will 404), then retry.',
  `For sites over ${MCP_PUBLISH_MAX_BYTES / 1024 / 1024} MB use fling_upload_begin, fling_upload_file (repeat, ` +
    '`append` for big files) and fling_upload_finish.',
  'Always give the user the URL that comes back. Use fling_list / fling_info to find existing sites, fling_rollback ' +
    'to restore a version, fling_archive rather than fling_delete unless the user insists.',
].join('\n\n')

export type McpToolName = (typeof mcpTools)[keyof typeof mcpTools]['name']
