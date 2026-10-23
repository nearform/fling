import type { Visibility } from '@fling/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errorMessage } from '../lib/api'
import { showToast } from '../lib/toast'

export const queryKeys = {
  me: ['me'] as const,
  sites: (archived: boolean) => ['sites', archived ? 'archived' : 'active'] as const,
  allSites: ['sites'] as const,
  site: (name: string) => ['site', name] as const,
  versionFiles: (name: string, versionId: string) => ['site', name, 'files', versionId] as const,
  keys: ['keys'] as const,
  connections: ['connections'] as const,
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

export function useLogout() {
  return useMutation({
    mutationFn: api.logout,
    // Reload whatever happened: a failed logout most likely means the session was already gone.
    onSettled: () => window.location.reload(),
  })
}
