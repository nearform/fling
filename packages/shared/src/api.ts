import { z } from 'zod'
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
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Site = z.infer<typeof SiteSchema>

export const VersionSchema = z.object({
  id: z.string(),
  fileCount: z.number(),
  totalBytes: z.number(),
  createdAt: z.string(),
})
export type Version = z.infer<typeof VersionSchema>

export const SiteDetailSchema = SiteSchema.extend({ versions: z.array(VersionSchema) })
export type SiteDetail = z.infer<typeof SiteDetailSchema>

export const SiteListSchema = z.object({ sites: z.array(SiteSchema) })

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

/** POST /api/sites/:name/deploys */
export const DeployRequestSchema = z.object({
  manifest: ManifestSchema,
  spa: z.boolean().optional(),
  visibility: VisibilitySchema.optional(),
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
})

/** POST /api/sites/:name/current  { versionId } */
export const RollbackRequestSchema = z.object({ versionId: z.string() })

/** PATCH /api/sites/:name  { visibility?, spa? } */
export const UpdateSiteRequestSchema = z.object({
  visibility: VisibilitySchema.optional(),
  spa: z.boolean().optional(),
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
