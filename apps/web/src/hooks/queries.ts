import type { CommentAnchor, Visibility } from '@fling/shared'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ADMIN_USERS_PATH } from '../lib/admin'
import { api, errorMessage } from '../lib/api'
import { showToast } from '../lib/toast'

export const queryKeys = {
  me: ['me'] as const,
  sites: (archived: boolean) => ['sites', archived ? 'archived' : 'active'] as const,
  allSites: ['sites'] as const,
  site: (name: string) => ['site', name] as const,
  versionFiles: (name: string, versionId: string) => ['site', name, 'files', versionId] as const,
  comments: (name: string) => ['comments', name] as const,
  keys: ['keys'] as const,
  connections: ['connections'] as const,
  adminUsers: (q: string) => ['admin', 'users', q] as const,
  adminAudit: ['admin', 'audit'] as const,
}

export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: api.me, staleTime: 5 * 60_000 })
}

export function useSites(archived: boolean) {
  return useQuery({ queryKey: queryKeys.sites(archived), queryFn: () => api.listSites(archived) })
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
  success?: string | ((result: TResult) => string)
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: queryKeys.allSites })
      queryClient.invalidateQueries({ queryKey: queryKeys.site(name) })
      if (success) showToast(typeof success === 'string' ? success : success(result))
    },
    onError: error => showToast(errorMessage(error), 'error'),
  })
}

export function useSiteActions(name: string) {
  return {
    setVisibility: useSiteMutation(
      name,
      (visibility: Visibility) => api.updateSite(name, { visibility }),
      'Visibility updated'
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

/** A site's comments, refetched now and then so a review session sees other people's. */
export function useComments(name: string) {
  return useQuery({
    queryKey: queryKeys.comments(name),
    queryFn: () => api.listComments(name),
    refetchInterval: 30_000,
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

export function useAdminAudit() {
  return useQuery({
    queryKey: queryKeys.adminAudit,
    queryFn: api.adminAudit,
    refetchInterval: 60_000,
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
