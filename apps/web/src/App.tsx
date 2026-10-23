import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { NotFound } from './components/NotFound'
import { Toasts } from './components/Toasts'
import { queryKeys, useMe } from './hooks/queries'
import { errorMessage, isUnauthorized } from './lib/api'
import ApiKeys from './pages/ApiKeys'
import Authorize from './pages/Authorize'
import GetStarted from './pages/GetStarted'
import Login from './pages/Login'
import Sites from './pages/Sites'

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    // A session that expires mid-visit: any 401 drops the cached user, which shows Login.
    onError: error => {
      if (isUnauthorized(error)) queryClient.setQueryData(queryKeys.me, null)
    },
  }),
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => !isUnauthorized(error) && failureCount < 2,
      refetchOnWindowFocus: true,
    },
  },
})

/** The signed-in shell. No session → Login; the user query failing outright → a retry card. */
function Authenticated() {
  const me = useMe()
  if (me.isPending) {
    return (
      <div className="min-h-screen grid place-items-center app-canvas">
        <span
          className="loading loading-spinner loading-md text-muted"
          role="status"
          aria-label="Loading"
        />
      </div>
    )
  }
  if (me.isError) {
    return (
      <div className="min-h-screen grid place-items-center app-canvas p-4">
        <div className="surface-panel max-w-md text-center space-y-4">
          <p>{errorMessage(me.error)}</p>
          <button type="button" className="btn btn-sm" onClick={() => me.refetch()}>
            Try again
          </button>
        </div>
      </div>
    )
  }
  if (!me.data) return <Login />
  return (
    <Layout>
      <Outlet />
    </Layout>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Authenticated />}>
            <Route index element={<Sites />} />
            <Route path="get-started" element={<GetStarted />} />
            <Route path="connections" element={<ApiKeys />} />
            <Route path="keys" element={<Navigate to="/connections" replace />} />
          </Route>
          {/* OAuth consent: signed-in, but outside the app shell */}
          <Route path="authorize" element={<Authorize />} />
          <Route path="login" element={<Login />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
      <Toasts />
    </QueryClientProvider>
  )
}
