import { z } from 'zod'
import { AccessLevelSchema } from './access.ts'
import { AudienceInputSchema, AudienceSchema } from './audience.ts'
import { ManifestSchema } from './manifest.ts'

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
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Site = z.infer<typeof SiteSchema>

/** A site with its audience, for its owner (`audiences` capability; older servers omit it). */
export const SiteWithAudienceSchema = SiteSchema.extend({ audience: AudienceSchema.optional() })
export type SiteWithAudience = z.infer<typeof SiteWithAudienceSchema>

export const VersionSchema = z.object({
  id: z.string(),
  fileCount: z.number(),
  totalBytes: z.number(),
  createdAt: z.string(),
})
export type Version = z.infer<typeof VersionSchema>

export const SiteDetailSchema = SiteWithAudienceSchema.extend({ versions: z.array(VersionSchema) })
export type SiteDetail = z.infer<typeof SiteDetailSchema>

export const SiteListSchema = z.object({ sites: z.array(SiteSchema) })

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
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type SharedSite = z.infer<typeof SharedSiteSchema>

export const SharedSiteListSchema = z.object({ sites: z.array(SharedSiteSchema) })

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
 */
export const DeployRequestSchema = z.object({
  manifest: ManifestSchema,
  spa: z.boolean().optional(),
  visibility: VisibilitySchema.optional(),
  access: AccessLevelSchema.optional(),
  audience: AudienceInputSchema.optional(),
})
export type DeployRequest = z.infer<typeof DeployRequestSchema>

export const UploadSchema = z.object({
  path: z.string(),
  url: z.string(),
  /** headers the client must send with the PUT (they are part of the signature) */
  headers: z.record(z.string(), z.string()),
})

export const DeployResponseSchema = z.discriminatedUnion('status', [
  /** content identical to the current version — nothing happened */
  z.object({ status: z.literal('unchanged'), versionId: z.string(), site: SiteSchema }),
  /** this content was deployed before — site now points at that version again */
  z.object({ status: z.literal('repointed'), versionId: z.string(), site: SiteSchema }),
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
})

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
 * `too_many_invites` past it).
 */
export const UpdateSiteRequestSchema = z.object({
  access: AccessLevelSchema.optional(),
  visibility: VisibilitySchema.optional(),
  spa: z.boolean().optional(),
  audience: AudienceInputSchema.optional(),
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
  lastSignInAt: z.string().nullable(),
  /** sites the user holds, archived ones included */
  siteCount: z.number(),
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
 * GET /api/admin/sites — every site on the instance, by name, in one response (clients search and
 * sort it): its listing, nothing of the owner's (versions, share link, audience).
 */
export const AdminSiteSchema = z.object({
  name: z.string(),
  url: z.string(),
  owner: z.string(),
  access: AccessLevelSchema,
  archived: z.boolean(),
  /** it has a current version */
  live: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type AdminSite = z.infer<typeof AdminSiteSchema>
export const AdminSiteListSchema = z.object({
  sites: z.array(AdminSiteSchema),
  /** the list stops at the server's ceiling: there are more sites than it holds */
  truncated: z.boolean(),
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
  email: z.string().trim().toLowerCase().min(3).max(254),
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
  ]),
  actor: z.string(),
  target: z.string(),
  /** invitation.create: how it came about (an admin's invite, a share, a group) */
  via: InvitationViaSchema.optional(),
  /** invitation.create: what it lets them be */
  role: InvitationRoleSchema.optional(),
  until: z.string().optional(),
  lapsed: z.boolean().optional(),
})
export type AuditEntry = z.infer<typeof AuditEntrySchema>
export const AuditListSchema = z.object({ entries: z.array(AuditEntrySchema) })

/**
 * POST /api/admin/impersonate { email } (browser session, an admin) → the new Me; POST
 * /api/admin/impersonate/stop → the admin's own Me again.
 */
export const ImpersonateRequestSchema = z.object({ email: z.string().trim().toLowerCase().min(3) })

/**
 * POST /auth/link { email, return? } (the `invites` capability): email a sign-in link to someone
 * invited from outside the email policy. Always 202 with no body, whatever the address, so the
 * answer never says who is invited. `return`: where to go once signed in (an app path or a site
 * URL; anything else becomes the app's home).
 */
export const SignInLinkRequestSchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(254),
  return: z.string().max(2048).optional(),
})
export type SignInLinkRequest = z.infer<typeof SignInLinkRequestSchema>

/** How long a sign-in link asked for on the login page works, in minutes. */
export const SIGN_IN_LINK_MINUTES = 15

/** The web page a sign-in link lands on (`/auth/link?t=` redirects here, the token in the hash). */
export const SIGN_IN_LINK_PAGE = '/sign-in/link'

/** Where a sign-in link's page posts the token (a native form POST: never sent until clicked). */
export const SIGN_IN_LINK_VERIFY_PATH = '/auth/link/verify'
