/**
 * The instance metadata for components: `useInstance()` gives the name, brand, auth and the rest,
 * or null while it loads (or if it can't be read — components then fall back to generic copy).
 * The app's provider fetches it with react-query; the standalone 404 passes its own.
 */
import type { InstanceMetadata } from '@fling/shared'
import { useQuery } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext } from 'react'
import { applyBrand, brandCacheFor, fetchInstance, readBrandCache } from '../lib/instance'

const InstanceContext = createContext<InstanceMetadata | null>(null)

export function InstanceProvider({
  value,
  children,
}: {
  value: InstanceMetadata | null
  children: ReactNode
}) {
  return <InstanceContext.Provider value={value}>{children}</InstanceContext.Provider>
}

export function useInstance(): InstanceMetadata | null {
  return useContext(InstanceContext)
}

/** The app: start from the cached copy, refetch, and apply the brand whenever it arrives. */
export function AppInstanceProvider({ children }: { children: ReactNode }) {
  const cached = readBrandCache()?.metadata
  const query = useQuery({
    queryKey: ['instance'],
    queryFn: async () => {
      const metadata = await fetchInstance()
      applyBrand(brandCacheFor(metadata))
      return metadata
    },
    initialData: cached,
    initialDataUpdatedAt: 0,
    staleTime: 5 * 60_000,
  })
  return <InstanceProvider value={query.data ?? null}>{children}</InstanceProvider>
}
