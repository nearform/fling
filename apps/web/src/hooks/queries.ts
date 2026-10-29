import type {
  AccessLevel,
  CommentAnchor,
  CreateGroupRequest,
  GroupDetail,
  Visibility,
} from '@fling/shared'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ADMIN_USERS_PATH } from '../lib/admin'
import { api, errorMessage } from '../lib/api'
import { showToast } from '../lib/toast'

export const queryKeys = {
  me: ['me'] as const,
  whySite: ['why'] as const,
  sites: (archived: boolean) => ['sites', archived ? 'archived' : 'active'] as const,
  allSites: ['sites'] as const,
  shared: ['sites', 'shared'] as const,
  site: (name: string) => ['site', name] as const,
  versionFiles: (name: string, versionId: string) => ['site', name, 'files', versionId] as const,
  comments: (name: string) => ['comments', name] as const,
  allGroups: ['groups'] as const,
  groups: (mine: boolean) => ['groups', mine ? 'mine' : 'all'] as const,
  groupsWithMembers: (emails: readonly string[]) => ['groups', 'members', ...emails] as const,
  group: (slug: string) => ['group', slug] as const,
  keys: ['keys'] as const,
  connections: ['connections'] as const,
  adminUsers: (q: string) => ['admin', 'users', q] as const,
  adminSites: ['admin', 'sites'] as const,
  adminAudit: ['admin', 'audit'] as const,
  adminInvitations: (q: string) => ['admin', 'invitations', q] as const,
  allAdminInvitations: ['admin', 'invitations'] as const,
  adminMail: ['admin', 'mail'] as const,
  adminSettings: ['admin', 'settings'] as const,
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
export function useSites(archived: boolean, enabled = true) {
  return useQuery({
    queryKey: queryKeys.sites(archived),
    queryFn: () => api.listSites(archived),
    enabled,
  })
}

/** The sites shared with the caller; fetched once the Shared tab is offered. */
export function useSharedSites(enabled: boolean) {
  return useQuery({ queryKey: queryKeys.shared, queryFn: api.listShared, enabled })
}

export function useSiteDetail(name: string, enabled: boolean) {
  return useQuery({ queryKey: queryKeys.site(name), queryFn: () => api.getSite(name), enabled })
}

/** A version's files never change (versions are content-addressed), so fetch once, when shown. */
export function useVersionFiles(name: string, versionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.versionFiles(name, versionId),
    queryFn: () => api.versionFiles(name, versionId),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  })
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
      if (success) showToast(typeof success === 'string' ? success : success(result))
    },
    onError: error => {
      if (toastErrors) showToast(errorMessage(error), 'error')
    },
  })
}

export function useSiteActions(name: string) {
  return {
    setVisibility: useSiteMutation(
      name,
      (visibility: Visibility) => api.updateSite(name, { visibility }),
      'Visibility updated'
    ),
    /**
     * The access level (`accessLevels` capability), with the whole audience for groups and people.
     * Refused addresses and unknown groups are the caller's to show.
     */
    setAccess: useSiteMutation(
      name,
      (choice: { access: AccessLevel; audience?: { emails: string[]; groups: string[] } }) =>
        api.updateSite(name, choice),
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
    share: useSiteMutation(name, () => api.share(name)),
    revokeShare: useSiteMutation(name, () => api.revokeShare(name), 'Share link revoked'),
    archive: useSiteMutation(name, () => api.archive(name), `${name} archived`),
    unarchive: useSiteMutation(name, () => api.unarchive(name), `${name} restored`),
    remove: useSiteMutation(name, () => api.deleteSite(name), `${name} deleted`),
    restoreVersion: useSiteMutation(
      name,
      (versionId: string) => api.setCurrentVersion(name, versionId),
      'Version restored — the site now serves it'
    ),
  }
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
  }
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

/** Admins: every site on the instance, whole (up to the server's ceiling); fetched when shown. */
export function useAdminSites(enabled: boolean) {
  return useQuery({ enabled, queryKey: queryKeys.adminSites, queryFn: api.adminSites })
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
