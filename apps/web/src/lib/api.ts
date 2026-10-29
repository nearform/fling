/**
 * The one fetch wrapper. Same origin, so the session cookie rides along; every response is parsed
 * with the shared zod contract, and every failure becomes an `ApiError` carrying the server's
 * `{ error: { code, message } }` (or a synthetic code when the body is not that envelope).
 */
import {
  type AccessLevel,
  type AdminSettings,
  AdminSettingsSchema,
  type AdminSiteList,
  AdminSiteListSchema,
  type AdminUserList,
  AdminUserListSchema,
  ApiKeyListSchema,
  type ApiKeySchema,
  type AudienceInput,
  type AuditEntry,
  AuditListSchema,
  type Comment,
  type CommentAnchor,
  type CommentList,
  CommentListSchema,
  CommentSchema,
  type Connection,
  ConnectionListSchema,
  type CreateGroupRequest,
  ErrorEnvelopeSchema,
  type GroupDetail,
  GroupDetailSchema,
  GroupListSchema,
  type GroupMembersRequest,
  type GroupSummary,
  type LiveTicket,
  LiveTicketSchema,
  type MailAdmin,
  MailAdminSchema,
  type MailTestResult,
  MailTestResultSchema,
  type Me,
  MeSchema,
  type NotificationPreferencesUpdate,
  type NotificationSettings,
  NotificationSettingsSchema,
  OAuthDecisionSchema,
  type OAuthRequestInfo,
  OAuthRequestInfoSchema,
  type SentNotification,
  SentNotificationListSchema,
  type SharedSite,
  SharedSiteListSchema,
  type Site,
  type SiteDetail,
  SiteDetailSchema,
  SiteListSchema,
  type VersionFiles,
  VersionFilesSchema,
  type Visibility,
  WhySiteSchema,
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
const group = (slug: string) => `/api/groups/${encodeURIComponent(slug)}`

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
  /** The restricted sites others have shared with the caller (`audiences` capability). */
  async listShared(): Promise<SharedSite[]> {
    const { sites } = await request('/api/shared', SharedSiteListSchema)
    return sites
  },
  /** The instance's why-fling site, when it is public and live. */
  async whySite(): Promise<string | null> {
    const { url } = await request('/api/why', WhySiteSchema)
    return url
  },
  getSite: (name: string): Promise<SiteDetail> => request(site(name), SiteDetailSchema),
  /** The files in one version of a site, sorted by path. */
  versionFiles: (name: string, versionId: string): Promise<VersionFiles> =>
    request(`${site(name)}/versions/${encodeURIComponent(versionId)}/files`, VersionFilesSchema),
  updateSite: (
    name: string,
    body: {
      access?: AccessLevel
      visibility?: Visibility
      spa?: boolean
      audience?: AudienceInput
    }
  ) => request(site(name), ignoreBody, { method: 'PATCH', body }),
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
  /** Where to join the site's live room, and the short-lived ticket to join with. */
  liveTicket: (name: string): Promise<LiveTicket> =>
    request(`${site(name)}/live`, LiveTicketSchema, { method: 'POST' }),
  deleteComment: (name: string, id: string) =>
    request(`${site(name)}/comments/${encodeURIComponent(id)}`, ignoreBody, { method: 'DELETE' }),
  /** Every group on the instance, or only the caller's own (`mine`), by slug. */
  async listGroups(mine = false): Promise<GroupSummary[]> {
    const { groups } = await request(`/api/groups${mine ? '?mine=1' : ''}`, GroupListSchema)
    return groups
  },
  /** The groups whose members are exactly `emails`, by slug. */
  async groupsWithMembers(emails: readonly string[]): Promise<GroupSummary[]> {
    const members = encodeURIComponent(emails.join(','))
    const { groups } = await request(`/api/groups?members=${members}`, GroupListSchema)
    return groups
  },
  getGroup: (slug: string): Promise<GroupDetail> => request(group(slug), GroupDetailSchema),
  createGroup: (body: CreateGroupRequest): Promise<GroupDetail> =>
    request('/api/groups', GroupDetailSchema, { method: 'POST', body }),
  /** The owner only, like every change to a group. */
  renameGroup: (slug: string, name: string): Promise<GroupDetail> =>
    request(group(slug), GroupDetailSchema, { method: 'PATCH', body: { name } }),
  changeGroupMembers: (slug: string, body: GroupMembersRequest): Promise<GroupDetail> =>
    request(`${group(slug)}/members`, GroupDetailSchema, { method: 'POST', body }),
  /** Sites whose audience names it keep their restriction; anyone it let in loses access. */
  deleteGroup: (slug: string) => request(group(slug), ignoreBody, { method: 'DELETE' }),
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
  /** Admins only: a page of users, by email, optionally under an email prefix. */
  adminUsers(q: string, cursor?: string): Promise<AdminUserList> {
    const params = new URLSearchParams()
    if (q.trim()) params.set('q', q.trim())
    if (cursor) params.set('cursor', cursor)
    return request(`/api/admin/users${params.size ? `?${params}` : ''}`, AdminUserListSchema)
  },
  /** Admins only: every site's listing, by name (`truncated`: the server's ceiling cut it). */
  adminSites: (): Promise<AdminSiteList> => request('/api/admin/sites', AdminSiteListSchema),
  async adminAudit(): Promise<AuditEntry[]> {
    const { entries } = await request('/api/admin/audit', AuditListSchema)
    return entries
  },
  /** Start acting as `email` (this browser session only); returns who you now are. */
  impersonate: (email: string): Promise<Me> =>
    request('/api/admin/impersonate', MeSchema, { method: 'POST', body: { email } }),
  stopImpersonating: (): Promise<Me> =>
    request('/api/admin/impersonate/stop', MeSchema, { method: 'POST' }),
  /** Admins, on an instance with email: the mail settings and the last 24 hours of sending. */
  adminMail: (): Promise<MailAdmin> => request('/api/admin/mail', MailAdminSchema),
  /** Admins: the instance's configuration, secrets by name only. */
  adminSettings: (): Promise<AdminSettings> => request('/api/admin/settings', AdminSettingsSchema),
  /** Admins: send a test email to any address; the provider's id or the mapped error. */
  sendTestMail: (to: string): Promise<MailTestResult> =>
    request('/api/admin/mail/test', MailTestResultSchema, { method: 'POST', body: { to } }),
  /** The caller's notification settings (the `notifications` capability). */
  notifications: (): Promise<NotificationSettings> =>
    request('/api/me/notifications', NotificationSettingsSchema),
  updateNotifications: (body: NotificationPreferencesUpdate): Promise<NotificationSettings> =>
    request('/api/me/notifications', NotificationSettingsSchema, { method: 'PUT', body }),
  async sentNotifications(): Promise<SentNotification[]> {
    const { sent } = await request('/api/me/notifications/sent', SentNotificationListSchema)
    return sent
  },
}

/** Full-page redirect into the instance's sign-in; the API sends the browser back to `returnTo`. */
export function loginUrl(returnTo: string): string {
  return `/auth/login?return=${encodeURIComponent(returnTo)}`
}
