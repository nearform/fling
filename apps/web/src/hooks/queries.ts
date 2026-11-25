import {
  type AccessLevel,
  type CommentAnchor,
  type CreateCommentRequest,
  type CreateGroupRequest,
  type DeletedSite,
  deletedText,
  type GroupDetail,
  recoverableDeletesOf,
  type SiteRoleInput,
  type Visibility,
} from '@fling/shared'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { ADMIN_USERS_PATH } from '../lib/admin'
import { ApiError, api, errorMessage } from '../lib/api'
import { LOGS_FOLLOW_MS, LOGS_SINCE } from '../lib/servers'
import { showToast } from '../lib/toast'
import { useInstance } from './instance'

export const queryKeys = {
  me: ['me'] as const,
  whySite: ['why'] as const,
  sites: (archived: boolean, metrics = false) =>
    ['sites', archived ? 'archived' : metrics ? 'active+metrics' : 'active'] as const,
  allSites: ['sites'] as const,
  shared: ['sites', 'shared'] as const,
  site: (name: string) => ['site', name] as const,
  versionFiles: (name: string, versionId: string, folder?: string) =>
    folder
      ? (['site', name, 'files', versionId, folder] as const)
      : (['site', name, 'files', versionId] as const),
  // Under the site's key, so whatever refetches the site refetches its Paths too.
  paths: (name: string) => ['site', name, 'paths'] as const,
  path: (name: string, folder: string) => ['site', name, 'paths', folder] as const,
  comments: (name: string) => ['comments', name] as const,
  // Under the comments' key, so whatever refetches the comments (the live room, a new comment or
  // response) refetches these too.
  forms: (name: string) => ['comments', name, 'forms'] as const,
  responses: (name: string) => ['comments', name, 'responses'] as const,
  allGroups: ['groups'] as const,
  groups: (mine: boolean) => ['groups', mine ? 'mine' : 'all'] as const,
  groupsWithMembers: (emails: readonly string[]) => ['groups', 'members', ...emails] as const,
  group: (slug: string) => ['group', slug] as const,
  keys: ['keys'] as const,
  connections: ['connections'] as const,
  adminUsers: (q: string) => ['admin', 'users', q] as const,
  adminSites: ['admin', 'sites'] as const,
  adminSitesPage: (q: string, owner: string) => ['admin', 'sites', q, owner] as const,
  adminAudit: ['admin', 'audit'] as const,
  adminInvitations: (q: string) => ['admin', 'invitations', q] as const,
  allAdminInvitations: ['admin', 'invitations'] as const,
  adminMail: ['admin', 'mail'] as const,
  adminSettings: ['admin', 'settings'] as const,
  adminRouteTable: ['admin', 'route-table'] as const,
  adminUsage: ['admin', 'usage'] as const,
  adminArchivePolicy: ['admin', 'archive-policy'] as const,
  adminDeleted: (name: string) => ['admin', 'deleted', name] as const,
  allAdminDeleted: ['admin', 'deleted'] as const,
  // Under the site's key, so whatever refetches the site refetches these too.
  secrets: (name: string) => ['site', name, 'secrets'] as const,
  serverLogs: (name: string) => ['site', name, 'logs'] as const,
  metrics: (name: string) => ['site', name, 'metrics'] as const,
  notifications: ['notifications'] as const,
  sentNotifications: ['notifications', 'sent'] as const,
}

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: api.me, staleTime: 5 * 60_000 })
}

/** The instance's public why-fling site, or `null`: Get started links to it. */
export function useWhySite() {
  return useQuery({ queryKey: queryKeys.whySite, queryFn: api.whySite, staleTime: 5 * 60_000 })
}

/** The caller's own sites; `enabled` false for a guest, who owns none. */
export function useSites(archived: boolean, enabled = true, metrics = false) {
  return useQuery({ ...siteList(archived, metrics), enabled, select: l => l.sites })
}

/**
 * The caller's live sites with their metrics (`?metrics=1`): each one's days and them all added
 * up, in the one answer `useSites(false, …, true)` shares.
 */
export function useSitesMetrics(enabled: boolean) {
  return useQuery({ ...siteList(false, true), enabled, select: l => l.metrics ?? null })
}

const siteList = (archived: boolean, metrics: boolean) => ({
  queryKey: queryKeys.sites(archived, metrics && !archived),
  queryFn: () => api.listSites(archived, metrics && !archived),
})

/** The sites shared with the caller; fetched once the Shared tab is offered. */
export function useSharedSites(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.shared, queryFn: api.listShared, enabled })
}

export function useSiteDetail(name: string, enabled: boolean) {
  return useQuery({ queryKey: queryKeys.site(name), queryFn: () => api.getSite(name), enabled })
}

/**
 * A version's files (of the site, or of its Path at `folder`) never change (versions are
 * content-addressed), so fetch once, when shown.
 */
export function useVersionFiles(
  name: string,
  versionId: string,
  enabled: boolean,
  folder?: string
) {
  return useQuery({
    queryKey: queryKeys.versionFiles(name, versionId, folder),
    queryFn: () => api.versionFiles(name, versionId, folder),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  })
}

/** The site's Paths (`paths` capability): `enabled` false skips them. */
export function useSitePaths(name: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.paths(name),
    queryFn: () => api.listPaths(name),
    enabled,
  })
}

/** One Path and its versions. */
export function usePathDetail(name: string, folder: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.path(name, folder),
    queryFn: () => api.getPath(name, folder),
    enabled,
  })
}

/**
 * The changes to one Path: on success the site (its detail and Paths, all under its key) and the
 * site lists refetch, and the optional message is toasted; failures are toasted unless the caller
 * shows them.
 */
function usePathMutation<TVars, TResult>(
  name: string,
  fn: (vars: TVars) => Promise<TResult>,
  success?: string | ((vars: TVars) => string),
  toastErrors = true
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (_result, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.site(name) })
      queryClient.invalidateQueries({ queryKey: queryKeys.allSites })
      if (success) showToast(typeof success === 'string' ? success : success(vars))
    },
    onError: error => {
      if (toastErrors) showToast(errorMessage(error), 'error')
    },
  })
}

export function usePathActions(name: string, folder: string) {
  const queryClient = useQueryClient()
  const recoverable = recoverableDeletesOf(useInstance())
  const shown = `/${folder}/`
  return {
    /** The whole new owners or publishers; refusals are the caller's to show. */
    setRoles: usePathMutation(
      name,
      (change: { owners?: SiteRoleInput; publishers?: SiteRoleInput }) =>
        api.updatePath(name, folder, change),
      'Owners and publishers updated',
      false
    ),
    setArchived: usePathMutation(
      name,
      (archived: boolean) => api.updatePath(name, folder, { archived }),
      archived => (archived ? `${shown} archived` : `${shown} restored`)
    ),
    restoreVersion: usePathMutation(
      name,
      (versionId: string) => api.setPathVersion(name, folder, versionId),
      `Version restored — ${shown} now serves it`
    ),
    remove: useMutation({
      mutationFn: () => api.deletePath(name, folder),
      onSuccess: () => {
        queryClient.removeQueries({ queryKey: queryKeys.path(name, folder) })
        queryClient.invalidateQueries({ queryKey: queryKeys.site(name) })
        queryClient.invalidateQueries({ queryKey: queryKeys.allSites })
        showToast(deletedText(recoverable, name, folder))
      },
      onError: error => showToast(errorMessage(error), 'error'),
    }),
  }
}

export function useApiKeys() {
  return useQuery({ queryKey: queryKeys.keys, queryFn: api.listKeys })
}

/**
 * A mutation on one site: on success every site list and that site's detail refetch, and the
 * optional `success` message is toasted; failures are always toasted.
 */
function useSiteMutation<TVars, TResult>(
  name: string,
  fn: (vars: TVars) => Promise<TResult>,
  success?: string | ((result: TResult) => string),
  /** false: the caller shows the failure itself, next to what failed */
  toastErrors = true
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: queryKeys.allSites })
      queryClient.invalidateQueries({ queryKey: queryKeys.site(name) })
      // An admin may have changed a site from All sites.
      queryClient.invalidateQueries({ queryKey: queryKeys.adminSites })
      if (success) showToast(typeof success === 'string' ? success : success(result))
    },
    onError: error => {
      // A server going public is the caller's to confirm (SiteAccess), never a failure to toast.
      if (error instanceof ApiError && error.code === 'public_server') return
      if (toastErrors) showToast(errorMessage(error), 'error')
    },
  })
}

/**
 * Keep a thumbnail the site page's preview took (`thumbnails` capability). Quiet either way: nobody
 * asked for it, and a refusal (another version went live meanwhile) is put right next time.
 */
export function useSaveThumbnail(name: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ versionId, png }: { versionId: string; png: Blob }) =>
      api.putThumbnail(name, versionId, png),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.allSites })
      queryClient.invalidateQueries({ queryKey: queryKeys.site(name) })
      queryClient.invalidateQueries({ queryKey: queryKeys.adminSites })
    },
  })
}

export function useSiteActions(name: string) {
  const recoverable = recoverableDeletesOf(useInstance())
  return {
    /** `confirmPublicServer`: retried once the publisher confirmed a public server. */
    setVisibility: useSiteMutation(
      name,
      (visibility: Visibility | { visibility: Visibility; confirmPublicServer: true }) =>
        api.updateSite(name, typeof visibility === 'string' ? { visibility } : visibility),
      'Visibility updated'
    ),
    /**
     * The access level (`accessLevels` capability), with the whole audience for groups and people.
     * Refused addresses and unknown groups are the caller's to show.
     */
    setAccess: useSiteMutation(
      name,
      (choice: {
        access: AccessLevel
        audience?: { emails: string[]; groups: string[] }
        confirmPublicServer?: boolean
      }) => api.updateSite(name, choice),
      'Access updated',
      false
    ),
    /**
     * The whole audience: its addresses and its groups by slug. Refused addresses and unknown
     * groups are the caller's to show.
     */
    setAudience: useSiteMutation(
      name,
      (audience: { emails: string[]; groups: string[] }) => api.updateSite(name, { audience }),
      'Audience updated',
      false
    ),
    /**
     * The whole new owners or publishers (`siteRoles` capability): addresses and groups by slug.
     * Refused addresses, unknown groups and `last_owner` are the caller's to show.
     */
    setRoles: useSiteMutation(
      name,
      (change: { owners?: SiteRoleInput; publishers?: SiteRoleInput }) =>
        api.updateSite(name, change),
      'Owners and publishers updated',
      false
    ),
    share: useSiteMutation(name, () => api.share(name)),
    revokeShare: useSiteMutation(name, () => api.revokeShare(name), 'Share link revoked'),
    archive: useSiteMutation(name, () => api.archive(name), `${name} archived`),
    unarchive: useSiteMutation(name, () => api.unarchive(name), `${name} restored`),
    /** The keep flag (`archivePolicy` capability): exempt it from the archive policy, or not. */
    setKeep: useSiteMutation(
      name,
      (keep: boolean) => api.setKeep(name, keep),
      site => (site.keep ? `${name} is kept` : `${name} is no longer kept`)
    ),
    remove: useSiteMutation(name, () => api.deleteSite(name), deletedText(recoverable, name)),
    restoreVersion: useSiteMutation(
      name,
      (versionId: string) => api.setCurrentVersion(name, versionId),
      'Version restored — the site now serves it'
    ),
  }
}

/** The site secrets by name and what the live version declares (`servers` capability). */
export function useSiteSecrets(name: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.secrets(name),
    queryFn: () => api.siteSecrets(name),
    enabled,
    retry: false,
  })
}

/**
 * Set or remove a site secret; the list (and the site) refetch. What it did (the outcome) is the
 * caller's to show, and a failure to set one too.
 */
export function useSecretActions(name: string) {
  const set = useSiteMutation(
    name,
    ({ secret, value }: { secret: string; value: string }) =>
      api.putSiteSecret(name, secret, value),
    undefined,
    false
  )
  const remove = useSiteMutation(name, (secret: string) => api.deleteSiteSecret(name, secret))
  return { set, remove }
}

/** A site's metrics (the `metrics` capability), for its owners, publishers and admins. */

export function useSiteMetrics(name: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.metrics(name),
    queryFn: () => api.siteMetrics(name),
    enabled,
    retry: false,
    staleTime: 60_000,
  })
}

/**
 * The site server's last hour of log, shared by the Logs panel and the request counts. `follow`
 * asks again every 2 s; otherwise once a minute.
 */
export function useServerLogs(name: string, enabled: boolean, follow = false) {
  return useQuery({
    queryKey: queryKeys.serverLogs(name),
    queryFn: () => api.siteLogs(name, LOGS_SINCE),
    enabled,
    retry: false,
    refetchInterval: follow ? LOGS_FOLLOW_MS : 60_000,
  })
}

/** Admins: a site server's kill switch and limits. Failures are toasted. */
export function useAdminServer(name: string) {
  return useSiteMutation(
    name,
    (body: Parameters<typeof api.adminSetServer>[1]) => api.adminSetServer(name, body),
    result =>
      result.stopped
        ? `${result.name}'s server is stopped: /api/* answers 503`
        : `${result.name}'s server is updated`
  )
}

/** Admins: whose viewer id it is on this site. Audited; failures are toasted. */
export function useResolveViewer(name: string) {
  return useMutation({
    mutationFn: (id: string) => api.resolveViewer(name, id),
    onError: error => showToast(errorMessage(error), 'error'),
  })
}

/**
 * A site's comments, refetched now and then so a review session sees other people's: every 30 s,
 * or every 5 minutes as a safety net while the live room (useLive) signals each change.
 */
export function useComments(name: string, opts: { live?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.comments(name),
    queryFn: () => api.listComments(name),
    refetchInterval: opts.live ? 300_000 : 30_000,
  })
}

/** Add, resolve and delete comments on one site; each refetches the list, failures are toasted. */
export function useCommentActions(name: string) {
  const queryClient = useQueryClient()
  const options = {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.comments(name) }),
    onError: (error: unknown) => showToast(errorMessage(error), 'error'),
  }
  return {
    add: useMutation({
      mutationFn: (body: {
        body: string
        path?: string
        parentId?: string
        anchor?: CommentAnchor
      }) => api.addComment(name, body),
      ...options,
    }),
    resolve: useMutation({
      mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) =>
        api.resolveComment(name, id, resolved),
      ...options,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.deleteComment(name, id),
      ...options,
    }),
    /** A response to a form; field errors are the form's to show, anything else is toasted. */
    respond: useMutation({
      mutationFn: (body: {
        path: string
        anchor?: CommentAnchor
        response: NonNullable<CreateCommentRequest['response']>
      }) => api.addComment(name, body),
      onSuccess: options.onSuccess,
      onError: (error: unknown) => {
        if (error instanceof ApiError && error.fieldErrors.length > 0) return
        options.onError(error)
      },
    }),
  }
}

/** A site's forms config (`forms` capability): `enabled` false skips it. */
export function useForms(name: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.forms(name),
    queryFn: () => api.getForms(name),
    enabled,
    staleTime: 60_000,
  })
}

/** The responses the caller may see and each form's progress (`forms` capability). */
export function useResponses(name: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.responses(name),
    queryFn: () => api.listResponses(name),
    enabled,
  })
}

export function useGroups(mine: boolean, enabled = true) {
  return useQuery({
    queryKey: queryKeys.groups(mine),
    queryFn: () => api.listGroups(mine),
    enabled,
  })
}

/**
 * The groups of exactly these people (none asked for: none). The addresses are sorted for the
 * query key, so the same people in another order share one answer.
 */
export function useGroupsWithMembers(emails: readonly string[], enabled = true) {
  const sorted = [...new Set(emails.map(e => e.toLowerCase()))].sort()
  return useQuery({
    queryKey: queryKeys.groupsWithMembers(sorted),
    queryFn: () => api.groupsWithMembers(sorted),
    enabled: enabled && sorted.length > 0,
  })
}

export function useGroup(slug: string, enabled: boolean) {
  return useQuery({ queryKey: queryKeys.group(slug), queryFn: () => api.getGroup(slug), enabled })
}

/**
 * After a group changes: its lists refetch, and so do sites, whose audiences count its members
 * (and lose it when it is deleted).
 */
function useGroupChanged() {
  const queryClient = useQueryClient()
  return (slug: string, detail?: GroupDetail) => {
    if (detail) queryClient.setQueryData(queryKeys.group(slug), detail)
    else queryClient.removeQueries({ queryKey: queryKeys.group(slug) })
    queryClient.invalidateQueries({ queryKey: queryKeys.allGroups })
    queryClient.invalidateQueries({ queryKey: queryKeys.allSites })
    queryClient.invalidateQueries({ queryKey: ['site'] })
  }
}

/** Create a group; a taken slug or a refused address is the caller's to show. */
export function useCreateGroup() {
  const changed = useGroupChanged()
  return useMutation({
    mutationFn: (body: CreateGroupRequest) => api.createGroup(body),
    onSuccess: detail => {
      changed(detail.slug, detail)
      showToast(`Group ${detail.slug} created`)
    },
  })
}

/**
 * The owner's changes to one group. Renaming and deleting toast their failures; a refused member
 * is the caller's to show, next to the input.
 */
export function useGroupActions(slug: string) {
  const changed = useGroupChanged()
  const onError = (error: unknown) => showToast(errorMessage(error), 'error')
  return {
    rename: useMutation({
      mutationFn: (name: string) => api.renameGroup(slug, name),
      onSuccess: detail => {
        changed(slug, detail)
        showToast('Group renamed')
      },
      onError,
    }),
    changeMembers: useMutation({
      mutationFn: (body: { add?: string[]; remove?: string[] }) =>
        api.changeGroupMembers(slug, body),
      onSuccess: detail => changed(slug, detail),
    }),
    remove: useMutation({
      mutationFn: () => api.deleteGroup(slug),
      onSuccess: () => {
        changed(slug)
        showToast(`Group ${slug} deleted`)
      },
      onError,
    }),
  }
}

export function useRevokeKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.revokeKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.keys })
      showToast('CLI login revoked')
    },
    onError: error => showToast(errorMessage(error), 'error'),
  })
}

export function useConnections() {
  return useQuery({ queryKey: queryKeys.connections, queryFn: api.listConnections })
}

export function useRevokeConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.revokeConnection,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connections })
      showToast('Connection revoked')
    },
    onError: error => showToast(errorMessage(error), 'error'),
  })
}

/** Admins: users under an email prefix, a page at a time ("Load more"). */
export function useAdminUsers(q: string, enabled: boolean) {
  return useInfiniteQuery({
    enabled,
    queryKey: queryKeys.adminUsers(q),
    queryFn: ({ pageParam }) => api.adminUsers(q, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.cursor ?? undefined,
  })
}

/**
 * Admins: every site on the instance by name, under a name prefix and, with `owner`, only the
 * sites that address owns or publishes; a page at a time ("Load more"), fetched when shown.
 */
export function useAdminSites(filter: { q: string; owner: string }, enabled: boolean) {
  return useInfiniteQuery({
    enabled,
    queryKey: queryKeys.adminSitesPage(filter.q, filter.owner),
    // The last answer stays up while the next search runs, so the list doesn't flash empty.
    placeholderData: keepPreviousData,
    queryFn: ({ pageParam }) => api.adminSites(filter, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.cursor ?? undefined,
  })
}

/** Admins: the invitation directory under an address prefix, a page at a time ("Load more"). */
export function useAdminInvitations(q: string, enabled: boolean) {
  return useInfiniteQuery({
    enabled,
    queryKey: queryKeys.adminInvitations(q),
    queryFn: ({ pageParam }) => api.adminInvitations(q, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.cursor ?? undefined,
  })
}

/** Admins: invite a member, and revoke an invitation. Both refresh the list and the audit log. */
export function useInvitationActions() {
  const queryClient = useQueryClient()
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.allAdminInvitations })
    queryClient.invalidateQueries({ queryKey: queryKeys.adminAudit })
  }
  return {
    invite: useMutation({ mutationFn: api.invite, onSettled: refresh }),
    revoke: useMutation({
      mutationFn: api.revokeInvitation,
      onSuccess: i => showToast(`${i.email} can no longer sign in by invitation`),
      onError: error => showToast(errorMessage(error), 'error'),
      onSettled: refresh,
    }),
  }
}

export function useAdminAudit() {
  return useQuery({
    queryKey: queryKeys.adminAudit,
    queryFn: api.adminAudit,
    refetchInterval: 60_000,
  })
}

/** Admins: the mail settings and health; refreshed every minute while shown. */
export function useAdminMail(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: queryKeys.adminMail,
    queryFn: api.adminMail,
    refetchInterval: 60_000,
  })
}

/** Admins: the instance's configuration (it changes only with a deploy). */
export function useAdminSettings(enabled: boolean) {
  return useQuery({ enabled, queryKey: queryKeys.adminSettings, queryFn: api.adminSettings })
}

/** Admins: the route table's format and its rewrite, polled while the rewrite runs. */
export function useAdminRouteTable(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: queryKeys.adminRouteTable,
    queryFn: api.adminRouteTable,
    refetchInterval: query => {
      const rewrite = query.state.data?.rewrite
      return rewrite && !rewrite.finishedAt ? 60_000 : false
    },
  })
}

/**
 * Admins, on an instance with metrics: the instance's usage. The day buckets change as views come
 * in and the lap's tally once a lap ends, so a few minutes stale is fine.
 */
export function useAdminUsage(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: queryKeys.adminUsage,
    queryFn: api.adminUsage,
    retry: false,
    staleTime: 5 * 60_000,
  })
}

/** Admins: the deleted sites and Paths still kept, or one site name's (`name`). */
export function useAdminDeleted(name: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: queryKeys.adminDeleted(name),
    queryFn: () => api.adminDeleted(name),
    placeholderData: keepPreviousData,
  })
}

/**
 * Admins, in a browser session: restore a deleted site or a Path deleted on its own. The page shows
 * the result and the failure (a taken name comes with suggestions); both refresh the list, the
 * sites, Usage's line and the audit log.
 */
export function useRestoreActions() {
  const queryClient = useQueryClient()
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.allAdminDeleted })
    queryClient.invalidateQueries({ queryKey: queryKeys.allSites })
    queryClient.invalidateQueries({ queryKey: queryKeys.adminSites })
    queryClient.invalidateQueries({ queryKey: queryKeys.adminUsage })
    queryClient.invalidateQueries({ queryKey: queryKeys.adminAudit })
  }
  return {
    site: useMutation({
      mutationFn: ({ siteId, name }: { siteId: string; name?: string }) =>
        api.restoreSite(siteId, name),
      onSuccess: refresh,
    }),
    path: useMutation({
      mutationFn: ({ siteId, pathId }: { siteId: string; pathId: string }) =>
        api.restorePath(siteId, pathId),
      onSuccess: refresh,
    }),
  }
}

/**
 * Admins, in a browser session: delete a deleted site (its Paths with it) or a Path deleted on its
 * own for good. The page shows the failure; success refreshes the list, Usage's line and the audit
 * log.
 */
export function usePurgeDeleted() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (d: Pick<DeletedSite, 'kind' | 'siteId' | 'pathId'>) =>
      d.kind === 'path' && d.pathId ? api.purgePath(d.siteId, d.pathId) : api.purgeSite(d.siteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.allAdminDeleted })
      queryClient.invalidateQueries({ queryKey: queryKeys.adminUsage })
      queryClient.invalidateQueries({ queryKey: queryKeys.adminAudit })
    },
  })
}

/** Admins: choose the route format; the panel shows the rewrite it starts. */
export function useSetRouteFormat() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.setRouteFormat,
    onSuccess: data => queryClient.setQueryData(queryKeys.adminRouteTable, data),
  })
}

/** Admins: turn view counting on or off; the page shows the rollout from the answer. */
export function useSetViewCounting() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.setViewCounting,
    onSuccess: data => queryClient.setQueryData(queryKeys.adminUsage, data),
  })
}

/** Admins: the archive policy (Admin → Archive policy), on every instance. */
export function useAdminArchivePolicy(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: queryKeys.adminArchivePolicy,
    queryFn: api.adminArchivePolicy,
    retry: false,
  })
}

/** Admins, in a browser session: turn the archive policy live or back to dry run. */
export function useSetArchivePolicyLive() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.setArchivePolicyLive,
    onSuccess: data => {
      queryClient.setQueryData(queryKeys.adminArchivePolicy, data)
      queryClient.invalidateQueries({ queryKey: queryKeys.adminAudit })
    },
  })
}

/** Admins: send a test email. The page shows the result; the remaining count refetches. */
export function useSendTestMail() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.sendTestMail,
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.adminMail }),
  })
}

export function useNotificationSettings(enabled: boolean) {
  return useQuery({ enabled, queryKey: queryKeys.notifications, queryFn: api.notifications })
}

export function useSentNotifications(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: queryKeys.sentNotifications,
    queryFn: api.sentNotifications,
  })
}

/** Change notification settings; the answer is the settings after, so the cache takes it as is. */
export function useUpdateNotifications() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.updateNotifications,
    onSuccess: settings => queryClient.setQueryData(queryKeys.notifications, settings),
    onError: error => showToast(errorMessage(error), 'error'),
  })
}

/**
 * Start or stop an impersonation, then load `to` afresh: every cached answer was someone else's.
 */
export function useImpersonation() {
  const go = (to: string) => () => window.location.assign(to)
  const onError = (error: unknown) => showToast(errorMessage(error), 'error')
  return {
    start: useMutation({ mutationFn: api.impersonate, onSuccess: go('/'), onError }),
    stop: useMutation({
      mutationFn: api.stopImpersonating,
      onSuccess: go(ADMIN_USERS_PATH),
      // Lapsed or signed out meanwhile: reloading shows whichever session is left.
      onError: () => window.location.assign('/'),
    }),
  }
}

export function useLogout() {
  return useMutation({
    mutationFn: api.logout,
    // Reload whatever happened: a failed logout most likely means the session was already gone.
    onSettled: () => window.location.reload(),
  })
}
