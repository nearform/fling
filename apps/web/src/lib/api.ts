/**
 * The one fetch wrapper. Same origin, so the session cookie rides along; every response is parsed
 * with the shared zod contract, and every failure becomes an `ApiError` carrying the server's
 * `{ error: { code, message } }` (or a synthetic code when the body is not that envelope).
 */
import {
  ApiKeyListSchema,
  type ApiKeySchema,
  type Comment,
  type CommentAnchor,
  type CommentList,
  CommentListSchema,
  CommentSchema,
  type Connection,
  ConnectionListSchema,
  ErrorEnvelopeSchema,
  type Me,
  MeSchema,
  OAuthDecisionSchema,
  type OAuthRequestInfo,
  OAuthRequestInfoSchema,
  type Site,
  type SiteDetail,
  SiteDetailSchema,
  SiteListSchema,
  type VersionFiles,
  VersionFilesSchema,
  type Visibility,
} from '@fling/shared'

export type ApiKey = ReturnType<typeof ApiKeySchema.parse>

/** Anything with a zod-style `parse` — keeps this file free of a direct zod import. */
interface Parser<T> {
  parse(data: unknown): T
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

/** A readable message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Something went wrong'
}

const ignoreBody: Parser<void> = { parse: () => undefined }

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function request<T>(
  path: string,
  parser: Parser<T>,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch {
    throw new ApiError(0, 'network_error', 'Could not reach Fling. Check your connection.')
  }

  const data = await readJson(res)
  if (!res.ok) {
    const envelope = ErrorEnvelopeSchema.safeParse(data)
    if (envelope.success) {
      throw new ApiError(res.status, envelope.data.error.code, envelope.data.error.message)
    }
    throw new ApiError(res.status, `http_${res.status}`, `Request failed (${res.status})`)
  }

  try {
    return parser.parse(data)
  } catch {
    throw new ApiError(
      res.status,
      'invalid_response',
      'Fling sent a response this page cannot read'
    )
  }
}

const ShareResponseParser: Parser<{ shareUrl: string }> = {
  parse(data) {
    const shareUrl = (data as { shareUrl?: unknown } | undefined)?.shareUrl
    if (typeof shareUrl !== 'string') throw new Error('shareUrl missing')
    return { shareUrl }
  },
}

const site = (name: string) => `/api/sites/${encodeURIComponent(name)}`

export const api = {
  /** The signed-in user, or `null` when there is no session (401). */
  async me(): Promise<Me | null> {
    try {
      return await request('/api/me', MeSchema)
    } catch (error) {
      if (isUnauthorized(error)) return null
      throw error
    }
  },
  async listSites(archived: boolean): Promise<Site[]> {
    const { sites } = await request(`/api/sites${archived ? '?archived=1' : ''}`, SiteListSchema)
    return sites
  },
  getSite: (name: string): Promise<SiteDetail> => request(site(name), SiteDetailSchema),
  /** The files in one version of a site, sorted by path. */
  versionFiles: (name: string, versionId: string): Promise<VersionFiles> =>
    request(`${site(name)}/versions/${encodeURIComponent(versionId)}/files`, VersionFilesSchema),
  updateSite: (name: string, body: { visibility?: Visibility; spa?: boolean }) =>
    request(site(name), ignoreBody, { method: 'PATCH', body }),
  /** Creates the share link, or rotates it when one exists (the old link stops working). */
  share: (name: string) => request(`${site(name)}/share`, ShareResponseParser, { method: 'POST' }),
  revokeShare: (name: string) => request(`${site(name)}/share`, ignoreBody, { method: 'DELETE' }),
  archive: (name: string) => request(`${site(name)}/archive`, ignoreBody, { method: 'POST' }),
  unarchive: (name: string) => request(`${site(name)}/unarchive`, ignoreBody, { method: 'POST' }),
  deleteSite: (name: string) => request(site(name), ignoreBody, { method: 'DELETE' }),
  setCurrentVersion: (name: string, versionId: string) =>
    request(`${site(name)}/current`, ignoreBody, { method: 'POST', body: { versionId } }),
  /** A site's comments and what the caller may do (members too: it is how they review). */
  listComments: (name: string): Promise<CommentList> =>
    request(`${site(name)}/comments`, CommentListSchema),
  addComment: (
    name: string,
    body: { body: string; path?: string; parentId?: string; anchor?: CommentAnchor }
  ): Promise<Comment> => request(`${site(name)}/comments`, CommentSchema, { method: 'POST', body }),
  resolveComment: (name: string, id: string, resolved: boolean): Promise<Comment> =>
    request(`${site(name)}/comments/${encodeURIComponent(id)}`, CommentSchema, {
      method: 'PATCH',
      body: { resolved },
    }),
  deleteComment: (name: string, id: string) =>
    request(`${site(name)}/comments/${encodeURIComponent(id)}`, ignoreBody, { method: 'DELETE' }),
  async listKeys(): Promise<ApiKey[]> {
    const { keys } = await request('/api/keys', ApiKeyListSchema)
    return keys
  },
  revokeKey: (id: string) =>
    request(`/api/keys/${encodeURIComponent(id)}`, ignoreBody, { method: 'DELETE' }),
  async listConnections(): Promise<Connection[]> {
    const { connections } = await request('/api/connections', ConnectionListSchema)
    return connections
  },
  revokeConnection: (id: string) =>
    request(`/api/connections/${encodeURIComponent(id)}`, ignoreBody, { method: 'DELETE' }),
  /** A pending OAuth authorization (the consent page). */
  oauthRequest: (id: string): Promise<OAuthRequestInfo> =>
    request(`/api/oauth/requests/${encodeURIComponent(id)}`, OAuthRequestInfoSchema),
  /** Approve or deny it; returns where to send the browser (back to the app). */
  async decideOAuthRequest(id: string, approve: boolean): Promise<string> {
    const { redirectUrl } = await request(
      `/api/oauth/requests/${encodeURIComponent(id)}/${approve ? 'approve' : 'deny'}`,
      OAuthDecisionSchema,
      { method: 'POST' }
    )
    return redirectUrl
  },
  logout: () => request('/auth/logout', ignoreBody, { method: 'POST' }),
}

/** Full-page redirect into the instance's sign-in; the API sends the browser back to `returnTo`. */
export function loginUrl(returnTo: string): string {
  return `/auth/login?return=${encodeURIComponent(returnTo)}`
}
