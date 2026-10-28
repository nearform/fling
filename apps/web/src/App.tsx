import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { ImpersonationBanner } from './components/ImpersonationBanner'
import Layout from './components/Layout'
import { NotFound } from './components/NotFound'
import { Toasts } from './components/Toasts'
import { AppInstanceProvider } from './hooks/instance'
import { queryKeys, useMe } from './hooks/queries'
import { ADMIN_USERS_PATH } from './lib/admin'
import { errorMessage, isUnauthorized } from './lib/api'
import { ADMIN_MAIL_PATH, NOTIFICATION_SETTINGS_PATH } from './lib/notifications'
import AdminMail from './pages/AdminMail'
import AdminUsers from './pages/AdminUsers'
import ApiKeys from './pages/ApiKeys'
import Authorize from './pages/Authorize'
import GetStarted from './pages/GetStarted'
import Group from './pages/Group'
import Groups from './pages/Groups'
import Login from './pages/Login'
import Notifications from './pages/Notifications'
import Review from './pages/Review'
import Site from './pages/Site'
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

/**
 * The signed-in shell. No session → Login; the user query failing outright → a retry card. `bare`:
 * signed in, without the app's navigation (review mode needs the whole window).
 */
function Authenticated({ bare = false }: { bare?: boolean }) {
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
    <>
      {bare ? (
        <Outlet />
      ) : (
        <Layout>
          <Outlet />
        </Layout>
      )}
      <ImpersonationBanner />
    </>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppInstanceProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Authenticated />}>
              <Route index element={<Sites />} />
              <Route path="sites/:name" element={<Site />} />
              <Route path="groups" element={<Groups />} />
              <Route path="groups/:slug" element={<Group />} />
              <Route path="get-started" element={<GetStarted />} />
              <Route path="connections" element={<ApiKeys />} />
              <Route path="keys" element={<Navigate to="/connections" replace />} />
              <Route path={NOTIFICATION_SETTINGS_PATH.slice(1)} element={<Notifications />} />
              <Route path="admin/users" element={<AdminUsers />} />
              <Route path={ADMIN_MAIL_PATH.slice(1)} element={<AdminMail />} />
              <Route path="admin" element={<Navigate to={ADMIN_USERS_PATH} replace />} />
            </Route>
            <Route element={<Authenticated bare />}>
              <Route path="review/:name" element={<Review />} />
            </Route>
            {/* OAuth consent: signed-in, but outside the app shell */}
            <Route path="authorize" element={<Authorize />} />
            <Route path="login" element={<Login />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </AppInstanceProvider>
      <Toasts />
    </QueryClientProvider>
  )
}
