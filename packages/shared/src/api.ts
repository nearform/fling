import { z } from 'zod'
import { AccessLevelSchema } from './access.ts'
import { AudienceInputSchema, AudienceSchema } from './audience.ts'
import { FormsConfigSchema } from './forms.ts'
import { ROUTE_FORMATS } from './kvs.ts'
import { MAX_FILES, MAX_STORED_PATH_LENGTH } from './limits.ts'
import { DeployManifestSchema } from './manifest.ts'
import { SiteDaysSchema, SitesMetricsSchema } from './metrics.ts'
import { PublishPathSchema } from './publish-path.ts'
import {
  OwnersInputSchema,
  PublishersInputSchema,
  SiteRoleMembersSchema,
  SiteRoleSchema,
} from './site-roles.ts'
import { ServerConfigSchema, SiteServerSchema } from './site-server.ts'
import { EmailInputSchema } from './text.ts'
import { ThumbnailSchema, ThumbnailStampSchema } from './thumbnails.ts'

// Request/response contracts for the Fling HTTP API. All JSON. Auth is either the
// `__Host-fling_session` cookie (web UI) or `Authorization: Bearer <api key>` (CLI/MCP).

export const VisibilitySchema = z.enum(['private', 'public'])
export type Visibility = z.infer<typeof VisibilitySchema>

export const MeSchema = z.object({
  email: z.string(),
  name: z.string(),
  picture: z.string().nullable(),
  userSlug: z.string(),
  /** one of the instance's admins (servers from before admins don't say: false) */
  admin: z.boolean().default(false),
  /** a guest: someone invited from outside who reviews what is shared with them, nothing else */
  guest: z.boolean().default(false),
  /** while an admin impersonates this user: the admin (browser sessions only) */
  impersonator: z.string().optional(),
  /** …and when the impersonation lapses */
  impersonationEndsAt: z.string().optional(),
})
export type Me = z.infer<typeof MeSchema>

export const SiteSchema = z.object({
  name: z.string(),
  url: z.string(),
  visibility: VisibilitySchema,
  spa: z.boolean(),
  archived: z.boolean(),
  currentVersionId: z.string().nullable(),
  shareUrl: z.string().nullable(),
  /** who can open it (access.ts); servers before access levels omit it (`siteAccessLevel`) */
  access: AccessLevelSchema.optional(),
  /** private and limited to the owner and the audience (an empty one: the owner alone) */
  restricted: z.boolean().default(false),
  /** how many addresses and groups the audience names (kept, and ignored, while public) */
  audienceSize: z.number().default(0),
  /** how many of those are groups */
  audienceGroups: z.number().default(0),
  /** the caller's role on it (site-roles.ts); servers before site roles omit it */
  role: SiteRoleSchema.optional(),
  /** the caller may pull its current version (`pull` capability; servers without it omit it) */
  canPull: z.boolean().optional(),
  /** its home page's thumbnail, when it has one (`thumbnails` capability; thumbnails.ts) */
  thumbnail: ThumbnailSchema.optional(),
  /**
   * its current version has a site server, run for `/api/*` (`servers` capability; site-server.ts):
   * the review page says so. Servers without the capability omit it
   */
  hasServer: z.boolean().optional(),
  /**
   * its views and pushes a day (`GET /api/sites?metrics=1`, live sites, where the instance has
   * metrics): one of the sites its list's `metrics` adds up
   */
  days: SiteDaysSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Site = z.infer<typeof SiteSchema>

/**
 * A site with its audience, for its owner (`audiences` capability; older servers omit it), and its
 * owners and publishers (site-roles.ts; servers before site roles omit them).
 */
export const SiteWithAudienceSchema = SiteSchema.extend({
  audience: AudienceSchema.optional(),
  owners: SiteRoleMembersSchema.optional(),
  publishers: SiteRoleMembersSchema.optional(),
})
export type SiteWithAudience = z.infer<typeof SiteWithAudienceSchema>

export const VersionSchema = z.object({
  id: z.string(),
  fileCount: z.number(),
  totalBytes: z.number(),
  /** who published it (email); absent on versions published before it was recorded */
  publishedBy: z.string().optional(),
  /**
   * A Path's version: the Path's folder (`PAY-412`, shown as `/PAY-412/`). A publish on a base:
   * the version it built on, carrying its other files forward
   */
  path: z.string().optional(),
  base: z.string().optional(),
  /** it has a site server (`servers` capability) */
  server: z.boolean().optional(),
  createdAt: z.string(),
})
export type Version = z.infer<typeof VersionSchema>

/**
 * GET /api/sites/:name. `owner`: its first person owner (an admin may open anyone's); servers
 * before admins could open other people's sites omit it.
 */
export const SiteDetailSchema = SiteWithAudienceSchema.extend({
  owner: z.string().optional(),
  versions: z.array(VersionSchema),
  /** its server, while the current version has one (`servers` capability) */
  server: SiteServerSchema.optional(),
  /**
   * a publish waiting for site secrets (409 `secrets_missing`): the pending version, and the
   * secrets it was missing then. Setting the last of them takes it live (`servers` capability)
   */
  awaitingSecrets: z.object({ versionId: z.string(), secrets: z.array(z.string()) }).optional(),
})
export type SiteDetail = z.infer<typeof SiteDetailSchema>

/**
 * GET /api/sites?archived=&sort=&limit=&cursor=&metrics= — the caller's sites, in `sort` order.
 * With `limit`, one page of at most that many (`SITE_LIST_PAGE_MAX`) and the cursor for the next;
 * without it, every one (and no cursor). With `metrics=1` (live sites, the `metrics` capability),
 * each site's days and them all added up, read together (views.ts `listedMetrics`).
 */
export const SiteListSchema = z.object({
  sites: z.array(SiteSchema),
  /** pass back as `cursor` for the next page; null or absent: no more */
  cursor: z.string().nullable().optional(),
  /** with `?metrics=1`, live sites, where the instance has metrics: them all added up */
  metrics: SitesMetricsSchema.optional(),
})
export type SiteList = z.infer<typeof SiteListSchema>

/**
 * One of a site's Paths (`paths` capability; paths.ts in the API): a top-level folder with its own
 * versions, owners and publishers, served at `url`. Its owners and publishers (who may change it,
 * besides the site's owners) are given to those on the site (`site.read`) and to its owners;
 * `canPublish` and `canManage` say what the caller may do to it.
 */
export const SitePathSchema = z.object({
  folder: z.string(),
  /** the `<title>` of its index.html, '' without one */
  title: z.string(),
  url: z.string(),
  currentVersionId: z.string().nullable(),
  archived: z.boolean(),
  owners: SiteRoleMembersSchema.optional(),
  publishers: SiteRoleMembersSchema.optional(),
  createdBy: z.string().optional(),
  canPublish: z.boolean(),
  /** the caller may change its owners and publishers, archive and delete it */
  canManage: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SitePath = z.infer<typeof SitePathSchema>

/** GET /api/sites/:name/paths: the site's Paths, by folder. */
export const PathListSchema = z.object({ paths: z.array(SitePathSchema) })

/** GET /api/sites/:name/paths/:folder: the Path, with its versions (newest first). */
export const PathDetailSchema = SitePathSchema.extend({ versions: z.array(VersionSchema) })
export type PathDetail = z.infer<typeof PathDetailSchema>

/**
 * PATCH /api/sites/:name/paths/:folder: `owners` and `publishers` replace those lists (the Path's
 * owners, or the site's); `archived` takes it off the site, or puts it back.
 */
export const UpdatePathRequestSchema = z.object({
  owners: OwnersInputSchema.optional(),
  publishers: PublishersInputSchema.optional(),
  archived: z.boolean().optional(),
})

/**
 * A restricted site someone else owns that the caller may see, because its audience names them or
 * a group they are in (GET /api/shared, `audiences` capability). What a viewer needs to open it and
 * nothing of the owner's: no versions, share link or audience.
 */
export const SharedSiteSchema = z.object({
  name: z.string(),
  url: z.string(),
  /** the site's review page (`comments` capability) */
  reviewUrl: z.string().optional(),
  owner: z.string(),
  /** how the caller is in the audience: by address, and through which of their groups (slugs) */
  via: z.object({ direct: z.boolean(), groups: z.array(z.string()) }),
  /** when its thumbnail was taken, when it has one (`thumbnails` capability) */
  thumbnail: ThumbnailStampSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SharedSite = z.infer<typeof SharedSiteSchema>

/** GET /api/shared?sort=&limit=&cursor= — paged as GET /api/sites is. */
export const SharedSiteListSchema = z.object({
  sites: z.array(SharedSiteSchema),
  /** pass back as `cursor` for the next page; null or absent: no more */
  cursor: z.string().nullable().optional(),
})

/**
 * GET /api/sites/:name/versions/:versionId/files — the files in one version (owner only; 404 for
 * an unknown site or version). Paths are sorted. `generatedIndex` is true when the root
 * index.html is the "List HTML files" page Fling generated (it carries the `fling-listing`
 * generator marker).
 */
export const SiteFileSchema = z.object({
  path: z.string(),
  size: z.number(),
  contentType: z.string(),
})
export type SiteFile = z.infer<typeof SiteFileSchema>

export const VersionFilesSchema = z.object({
  versionId: z.string(),
  files: z.array(SiteFileSchema),
  totalBytes: z.number(),
  generatedIndex: z.boolean(),
})
export type VersionFiles = z.infer<typeof VersionFilesSchema>

/** How long the download URLs a pull hands out stay good. */
export const PULL_URL_TTL_SECONDS = 15 * 60

/** One file of a pulled version: what to fetch, and what its bytes must hash to. */
export const PullFileSchema = SiteFileSchema.extend({
  /** hex SHA-256 of the bytes */
  sha256: z.string(),
  /** a signed GET for the bytes, good for PULL_URL_TTL_SECONDS */
  url: z.string(),
})
export type PullFile = z.infer<typeof PullFileSchema>

/**
 * GET /api/sites/:name/pull[?version=&path=] (`pull` capability): a version's files to change and
 * publish again. Anyone signed in who can see the site pulls its current version; another version
 * also needs to be an owner, publisher or admin (`version.read`). 404 like a missing site
 * otherwise, and for a site with no current version or an archived one. `path` limits it to one
 * folder (publish-path.ts); the files keep their site paths. Publishing on `versionId` as the
 * `base` sends only what changed (DeployRequest).
 */
export const PullResponseSchema = z.object({
  versionId: z.string(),
  path: z.string().optional(),
  files: z.array(PullFileSchema),
  /** when the URLs stop working */
  expiresAt: z.string(),
  /** the version's forms config (`fling.forms.json`; `forms` capability), absent when it has none */
  forms: FormsConfigSchema.optional(),
  /**
   * the version's server config, as its `fling.json` declared it (`servers` capability): absent
   * when it has no server. `fling.json` is a build input, never one of the `files`.
   */
  server: ServerConfigSchema.optional(),
})
export type PullResponse = z.infer<typeof PullResponseSchema>

/**
 * GET /api/names/:name — can the caller fling to this name?
 * - available: nobody has it   - yours: the caller's existing site (a fling updates it)
 * - taken: someone else's       - invalid: fails isValidSiteName (incl. reserved)
 * `suggestions` (free names from nameSuggestions(): `<name>-<initials>`, `<name>-<initials>2`, …)
 * is filled for taken/invalid.
 * A deploy to a name someone else owns fails 409 with error code `name_taken`.
 */
export const NameCheckSchema = z.object({
  name: z.string(),
  status: z.enum(['available', 'yours', 'taken', 'invalid']),
  suggestions: z.array(z.string()),
})
export type NameCheck = z.infer<typeof NameCheckSchema>

/** GET /api/why: the instance's public why-fling site (`WHY_SITE_NAME`), `null` unless it is live. */
export const WhySiteSchema = z.object({ url: z.string().nullable() })
export type WhySite = z.infer<typeof WhySiteSchema>

/**
 * POST /api/sites/:name/deploys. `access` (and, for `groups` and `people`, `audience`) is who can
 * open a new site: it applies only while the site has never been live, so a re-deploy never
 * changes it. Without it a new site gets the instance's default (`defaultAccess` in the metadata).
 * `path` (`pathPublish` capability; publish-path.ts) publishes the Path at that top-level folder
 * (`paths` capability), making it on first use: every file in the manifest is under it
 * (`<path>/…`), and they are the Path's whole new version. The site's own files and other Paths
 * are untouched.
 *
 * `base` (`pull` capability) publishes on top of a version the client pulled, of the site or,
 * with `path`, of that Path: refused with 409 `base_changed` unless it is still current, when the
 * deploy is made and when it goes live. The files the base already has (same path and SHA-256) are
 * not uploaded: the server copies them forward. Without `partial`, the manifest is the whole new
 * version; with `partial: true` it holds only the files that changed or are new, and `remove`
 * lists the base's files to leave out (under `<path>/` for a Path). `partial` needs `base`, and
 * `remove` needs `partial`.
 *
 * `server` (`servers` capability; site-server.ts) is the folder's `fling.json` for a version whose
 * files include `_fling/server.mjs`: the site secrets it needs and its health path. Such a version
 * goes live only once its server answers a start probe (422 `server_failed_to_start`, with the
 * server's first log lines), and on a public site only with `confirmPublicServer: true` (409
 * `public_server` otherwise): anyone may then call its `/api/*` and use its secrets through it.
 *
 * `forms` (`forms` capability; forms.ts) is the new version's forms config, from `fling.forms.json`
 * (never itself a file of the site), or `null` for none. Omitted, a publish on a base keeps the
 * base's forms, and any other deploy has none. A Path's version keeps its own, beside it.
 */
export const DeployRequestSchema = z
  .object({
    manifest: DeployManifestSchema,
    path: PublishPathSchema.optional(),
    base: z.string().min(1).max(100).optional(),
    partial: z.boolean().optional(),
    remove: z.array(z.string().min(1).max(MAX_STORED_PATH_LENGTH)).max(MAX_FILES).optional(),
    spa: z.boolean().optional(),
    visibility: VisibilitySchema.optional(),
    access: AccessLevelSchema.optional(),
    audience: AudienceInputSchema.optional(),
    forms: FormsConfigSchema.nullable().optional(),
    server: ServerConfigSchema.optional(),
    confirmPublicServer: z.boolean().optional(),
  })
  .superRefine((req, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (req.manifest.files.length === 0 && !(req.partial && req.remove?.length)) {
      issue('manifest.files: at least one file')
    }
    if (req.partial && req.base === undefined) issue('`partial` needs `base`')
    if (req.remove !== undefined && !req.partial) issue('`remove` needs `partial: true`')
  })
export type DeployRequest = z.infer<typeof DeployRequestSchema>

export const UploadSchema = z.object({
  path: z.string(),
  url: z.string(),
  /** headers the client must send with the PUT (they are part of the signature) */
  headers: z.record(z.string(), z.string()),
})

/**
 * Something the publisher (often an agent) may want to act on, besides the result
 * (`paths` capability): `paths_index_missing`, the site has several Paths and its home page
 * doesn't list them (offer a Paths index: paths-templates.ts); `paths_block_hidden`, the site's
 * own files under these folders are hidden by its Paths of the same name (`folders`).
 */
export const PublishHintSchema = z.object({
  code: z.enum(['paths_index_missing', 'paths_block_hidden']),
  message: z.string(),
  folders: z.array(z.string()).optional(),
})
export type PublishHint = z.infer<typeof PublishHintSchema>

export const DeployResponseSchema = z.discriminatedUnion('status', [
  /** content identical to the current version — nothing happened */
  z.object({
    status: z.literal('unchanged'),
    versionId: z.string(),
    site: SiteSchema,
    hints: z.array(PublishHintSchema).optional(),
  }),
  /** this content was deployed before — site now points at that version again */
  z.object({
    status: z.literal('repointed'),
    versionId: z.string(),
    site: SiteSchema,
    hints: z.array(PublishHintSchema).optional(),
  }),
  /** new content — PUT every upload, then POST /api/sites/:name/deploys/:versionId/finalize */
  z.object({
    status: z.literal('upload'),
    versionId: z.string(),
    uploads: z.array(UploadSchema),
  }),
])
export type DeployResponse = z.infer<typeof DeployResponseSchema>

/** POST /api/sites/:name/deploys/:versionId/finalize */
export const FinalizeResponseSchema = z.object({
  status: z.literal('live'),
  versionId: z.string(),
  site: SiteSchema,
  /** this deploy made the site live for the first time (a new site, its access just set) */
  first: z.boolean().optional(),
  hints: z.array(PublishHintSchema).optional(),
})

/**
 * POST /api/sites/:name/uploads → UploadBeginResponseSchema: a sandbox upload (sandbox-upload.ts),
 * for the local MCP server's fling_upload_begin. The fields are a deploy's; the name is checked
 * first (400 `invalid_name`, 409 `name_taken` with suggestions).
 */
export const UploadBeginRequestSchema = z.object({
  path: PublishPathSchema.optional(),
  base: z.string().min(1).max(100).optional(),
  remove: z.array(z.string().min(1).max(MAX_STORED_PATH_LENGTH)).max(MAX_FILES).optional(),
  spa: z.boolean().optional(),
  access: AccessLevelSchema.optional(),
  audience: AudienceInputSchema.optional(),
})

export const UploadBeginResponseSchema = z.object({
  uploadId: z.string(),
  name: z.string(),
  path: z.string().optional(),
  expiresAt: z.string(),
  /** the command Claude runs in its sandbox (`<path>` replaced) */
  script: z.string(),
  /** the host the sandbox must reach */
  host: z.string(),
  /** where in Claude the host is allowed */
  allowAdvice: z.string(),
})

/** POST /api/uploads/:id/finish  { listHtml?, confirmPublicServer? } → UploadFinishResponseSchema */
export const UploadFinishRequestSchema = z.object({
  listHtml: z.boolean().optional(),
  confirmPublicServer: z.boolean().optional(),
})

export const UploadFinishResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('needs_decision'),
    htmlPages: z.array(z.string()),
    fileCount: z.number(),
  }),
  z.object({
    kind: z.literal('published'),
    status: z.enum(['live', 'unchanged', 'repointed']),
    versionId: z.string(),
    site: SiteSchema,
    first: z.boolean().optional(),
    fileCount: z.number(),
    totalBytes: z.number(),
    generatedIndex: z.boolean(),
    warnings: z.array(z.string()),
    path: z.string().optional(),
    hints: z.array(PublishHintSchema).optional(),
  }),
])
export type UploadFinishResponse = z.infer<typeof UploadFinishResponseSchema>

/** POST /api/sites/:name/current  { versionId } */
export const RollbackRequestSchema = z.object({ versionId: z.string() })

/**
 * PATCH /api/sites/:name  { access?, visibility?, spa?, audience? } → SiteWithAudienceSchema (the
 * audience when the patch set one). `access` sets the level (access.ts), with `audience` for
 * `groups` and `people`; it goes without `visibility`. Without `access`, `visibility` and
 * `audience` edit those alone: an audience naming someone restricts the site, an empty one opens it
 * to every member. An address the instance wouldn't let sign in is a 400 `email_not_allowed`, unless
 * the instance has outside invitations on (the `invites` capability): then an address the audience
 * adds is invited as a guest, at most `INVITES_PER_DAY` new ones a day per person (429
 * `too_many_invites` past it). `owners` and `publishers` (site-roles.ts) each replace the whole
 * list and come back with the site: their addresses must be members (400 `email_not_allowed`),
 * their groups must exist (400 `unknown_group`), and the owners must keep an address (400
 * `last_owner`); someone in both lists is an owner.
 */
export const UpdateSiteRequestSchema = z.object({
  access: AccessLevelSchema.optional(),
  visibility: VisibilitySchema.optional(),
  spa: z.boolean().optional(),
  audience: AudienceInputSchema.optional(),
  /** the whole new list of owners (site-roles.ts): owners only */
  owners: OwnersInputSchema.optional(),
  /** the whole new list of publishers (site-roles.ts): owners only */
  publishers: PublishersInputSchema.optional(),
  /** making a site whose live version has a server public (409 `public_server` without it) */
  confirmPublicServer: z.boolean().optional(),
})

export const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
})
export const ApiKeyListSchema = z.object({ keys: z.array(ApiKeySchema) })

export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
})
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

/**
 * GET /api/sites/:name/arrival — asked by the sites' 404 page on that site's own host, with the
 * visitor's session: whether the site is live, theirs to open, and new enough that the edge may
 * not have it yet. `false` for every site they can't open.
 */
export const SiteArrivalSchema = z.object({ arriving: z.boolean() })
export type SiteArrival = z.infer<typeof SiteArrivalSchema>

/** POST /api/sites/:name/share — creates or rotates the share link */
export const ShareResponseSchema = z.object({ shareUrl: z.string() })
export type ShareResponse = z.infer<typeof ShareResponseSchema>

/**
 * PATCH /api/sites/:name, POST …/current, …/archive, …/unarchive all respond with
 * SiteSchema (the updated site). DELETE /api/sites/:name and DELETE …/share respond 204.
 */
export const SiteResponseSchema = SiteSchema

/**
 * GET /api/connections — apps connected through OAuth (e.g. the Claude connector). Revoking one
 * (DELETE /api/connections/:id) kills its refresh token and, at once, its access tokens.
 */
export const ConnectionSchema = z.object({
  id: z.string(),
  clientName: z.string(),
  /** host the client identifies as (CIMD client_id host or redirect URI host) */
  clientHost: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
})
export type Connection = z.infer<typeof ConnectionSchema>
export const ConnectionListSchema = z.object({ connections: z.array(ConnectionSchema) })

/** GET /api/oauth/requests/:id — what the consent page shows. */
export const OAuthRequestInfoSchema = z.object({
  clientName: z.string(),
  clientUri: z.string().nullable(),
  /** host of the CIMD client_id URL, when the client identified itself that way */
  clientIdHost: z.string().nullable(),
  redirectHost: z.string(),
  /** true when the code goes to a loopback address (any local program could be asking) */
  loopback: z.boolean(),
  scopes: z.array(z.string()),
  email: z.string(),
})
export type OAuthRequestInfo = z.infer<typeof OAuthRequestInfoSchema>

/** POST /api/oauth/requests/:id/approve | /deny → where to send the browser. */
export const OAuthDecisionSchema = z.object({ redirectUrl: z.string() })

// --- admin (ADMIN_EMAILS only; anyone else gets 404s) ---

/** GET /api/admin/users?q=<email prefix>&cursor=&limit= — one page, by email. */
export const AdminUserSchema = z.object({
  email: z.string(),
  name: z.string(),
  picture: z.string().nullable(),
  userSlug: z.string(),
  createdAt: z.string().nullable(),
  /** to the day: the first sign-in on the (UTC) day of the last one */
  lastSignInAt: z.string().nullable(),
  admin: z.boolean(),
  /** outside the email policy, on a live guest invitation (see GET /api/admin/invitations) */
  guest: z.boolean(),
})
export type AdminUser = z.infer<typeof AdminUserSchema>
export const AdminUserListSchema = z.object({
  users: z.array(AdminUserSchema),
  /** pass back as `cursor` for the next page; null: no more */
  cursor: z.string().nullable(),
})
export type AdminUserList = z.infer<typeof AdminUserListSchema>

/**
 * GET /api/admin/sites?q=<name prefix>&owner=<email>&after=&limit= — one page of every site on the
 * instance, by name: its listing, nothing of the owner's (versions, share link, audience). `owner`:
 * only the sites that address owns or publishes, directly or through a group.
 */
export const AdminSiteSchema = z.object({
  name: z.string(),
  url: z.string(),
  owner: z.string(),
  access: AccessLevelSchema,
  archived: z.boolean(),
  /** it has a current version */
  live: z.boolean(),
  /** when its thumbnail was taken, when it has one (`thumbnails` capability) */
  thumbnail: ThumbnailStampSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** when a view of it was last counted (the `metrics` capability); absent: never */
  lastViewAt: z.string().optional(),
})
export type AdminSite = z.infer<typeof AdminSiteSchema>
export const AdminSiteListSchema = z.object({
  sites: z.array(AdminSiteSchema),
  /** pass back as `after` for the next page; null: no more */
  cursor: z.string().nullable(),
})
export type AdminSiteList = z.infer<typeof AdminSiteListSchema>

/** How the admins' Settings tab groups the instance's configuration, in this order. */
export const SETTING_GROUPS = [
  'sign_in',
  'sites',
  'branding',
  'features',
  'mail',
  'platform',
] as const
export type SettingGroup = (typeof SETTING_GROUPS)[number]

/** A setting's effective value: text, a number, a switch, a list, or nothing. */
export const SettingValueSchema = z
  .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
  .nullable()
export type SettingValue = z.infer<typeof SettingValueSchema>

/**
 * GET /api/admin/settings — every configuration key the instance reads, with the value it runs
 * with and whether the environment set it (`set: false`: the default, or what the instance
 * derives). Secrets are named, with whether they are set, and never carry a value.
 */
export const AdminSettingsSchema = z.object({
  settings: z.array(
    z.object({
      key: z.string(),
      group: z.enum(SETTING_GROUPS),
      value: SettingValueSchema,
      set: z.boolean(),
    })
  ),
  secrets: z.array(
    z.object({ name: z.string(), group: z.enum(SETTING_GROUPS), set: z.boolean() }).strict()
  ),
})
export type AdminSettings = z.infer<typeof AdminSettingsSchema>
export type AdminSetting = AdminSettings['settings'][number]
export type AdminSecret = AdminSettings['secrets'][number]

/**
 * GET /api/admin/route-table — the route table's format (kvs.ts RouteFormat), who chose it and
 * maintenance's rewrite of every site's routes into it, and how full the store is where it has a
 * size limit (`usage`; null where it has none), and maintenance's last lap of the site directory
 * (`lastLap`: how long it took and when it finished; null before the first). POST it `{ format }` (a browser session's admin)
 * to choose the format and start the rewrite.
 */
export const AdminRouteTableSchema = z.object({
  format: z.enum(ROUTE_FORMATS),
  setBy: z.string().optional(),
  setAt: z.string().optional(),
  rewrite: z
    .object({
      after: z.string().nullable(),
      sites: z.number().int(),
      finishedAt: z.string().optional(),
    })
    .optional(),
  /** how full the route store is; `items`, its routes, where the store counts them */
  usage: z
    .object({ bytes: z.number(), limitBytes: z.number(), items: z.number().optional() })
    .nullable(),
  /**
   * maintenance's last lap of the site directory: how long from the lap before's end, when, and
   * (laps finished since it was measured) how long the sweep worked at it, over how many runs,
   * for how many sites
   */
  lastLap: z
    .object({
      lapMs: z.number(),
      finishedAt: z.string(),
      workMs: z.number().optional(),
      runs: z.number().int().optional(),
      sites: z.number().int().optional(),
    })
    .nullable(),
  /** how often maintenance runs, and how long one run works at most */
  maintenance: z.object({ everyMs: z.number(), budgetMs: z.number() }),
})
export type AdminRouteTable = z.infer<typeof AdminRouteTableSchema>
export const RouteFormatRequestSchema = z.object({ format: z.enum(ROUTE_FORMATS) })

/** What an invitation lets someone outside the email policy be: a full user, or a guest. */
export const InvitationRoleSchema = z.enum(['member', 'guest'])
export type InvitationRole = z.infer<typeof InvitationRoleSchema>
/** How an invitation came about: an admin's invite, a site's audience, or a group. */
export const InvitationViaSchema = z.enum(['admin', 'share', 'group'])
export type InvitationVia = z.infer<typeof InvitationViaSchema>

/**
 * GET /api/admin/invitations?q=<email prefix>&cursor=&limit= (the `invites` capability; admins,
 * admin tokens too) — the invitation directory, one page by address: each address's invitation,
 * live or revoked, and whether they have signed in yet (from their user record).
 */
export const AdminInvitationSchema = z.object({
  email: z.string(),
  role: InvitationRoleSchema,
  /** who invited them: the admin, or whoever shared */
  invitedBy: z.string(),
  via: InvitationViaSchema,
  createdAt: z.string(),
  /** set once revoked; the invitation is kept as the record */
  revokedAt: z.string().nullable(),
  /** their first sign-in has happened */
  signedIn: z.boolean(),
  lastSignInAt: z.string().nullable(),
})
export type AdminInvitation = z.infer<typeof AdminInvitationSchema>
export const AdminInvitationListSchema = z.object({
  invitations: z.array(AdminInvitationSchema),
  /** pass back as `cursor` for the next page; null: no more */
  cursor: z.string().nullable(),
})
export type AdminInvitationList = z.infer<typeof AdminInvitationListSchema>

/**
 * POST /api/admin/invitations { email } (an admin's browser session) → AdminInviteResultSchema:
 * invite an address outside the email policy as a member (a guest becomes one; nobody is ever
 * demoted) and email them a 7-day sign-in link at once. An address the policy admits already is a
 * 400 `already_admitted`. DELETE /api/admin/invitations/:email (an admin's browser session) →
 * AdminInvitationSchema: revoke it, which ends the access it gave on their next request.
 */
export const InviteRequestSchema = z.object({
  email: EmailInputSchema,
})
export type InviteRequest = z.infer<typeof InviteRequestSchema>
export const AdminInviteResultSchema = z.object({
  invitation: AdminInvitationSchema,
  /** the provider took the email */
  sent: z.boolean(),
  /** why it didn't, in words (`rejected: sender not verified`) */
  error: z.string().nullable(),
})
export type AdminInviteResult = z.infer<typeof AdminInviteResultSchema>

/** GET /api/admin/audit — the latest admin actions and invitations, newest first. */
export const AuditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  action: z.enum([
    'impersonation.start',
    'impersonation.stop',
    'invitation.create',
    'invitation.revoke',
    'site.change',
    'site.open',
    'site.server_published',
    'viewer.resolved',
    'routes.format',
    'usage.view_counting',
    'site.delete',
    'site.restore',
    'path.delete',
    'path.restore',
    'site.purge',
    'path.purge',
  ]),
  actor: z.string(),
  /** the person, or for site.change and site.open the site's name */
  target: z.string(),
  /** site.change, site.open: the site's owner */
  owner: z.string().optional(),
  /** site.change: what the admin did (a policy action, e.g. `site.archive`) */
  change: z.string().optional(),
  /** invitation.create: how it came about (an admin's invite, a share, a group) */
  via: InvitationViaSchema.optional(),
  /** invitation.create: what it lets them be */
  role: InvitationRoleSchema.optional(),
  until: z.string().optional(),
  lapsed: z.boolean().optional(),
  /** site.* and path.* deletes, restores and purges: the site's id (its files' prefix) */
  siteId: z.string().optional(),
})
export type AuditEntry = z.infer<typeof AuditEntrySchema>
export const AuditListSchema = z.object({ entries: z.array(AuditEntrySchema) })

/**
 * POST /api/admin/impersonate { email } (browser session, an admin) → the new Me; POST
 * /api/admin/impersonate/stop → the admin's own Me again.
 */
export const ImpersonateRequestSchema = z.object({ email: EmailInputSchema })

/**
 * POST /auth/link { email, return? } (the `invites` capability): email a sign-in link to someone
 * invited from outside the email policy. Always 202 with no body, whatever the address, so the
 * answer never says who is invited. `return`: where to go once signed in (an app path or a site
 * URL; anything else becomes the app's home).
 */
export const SignInLinkRequestSchema = z.object({
  email: EmailInputSchema,
  return: z.string().max(2048).optional(),
})
export type SignInLinkRequest = z.infer<typeof SignInLinkRequestSchema>

/** How long a sign-in link asked for on the login page works, in minutes. */
export const SIGN_IN_LINK_MINUTES = 15

/** The web page a sign-in link lands on (`/auth/link?t=` redirects here, the token in the hash). */
export const SIGN_IN_LINK_PAGE = '/sign-in/link'

/** Where a sign-in link's page posts the token (a native form POST: never sent until clicked). */
export const SIGN_IN_LINK_VERIFY_PATH = '/auth/link/verify'
