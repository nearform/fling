import type { IdentityProvider } from './auth/identity.ts'
import type { SessionClaims } from './auth/session.ts'
import type { Blobs } from './blobs/types.ts'
import type { Config } from './config.ts'
import type { LiveHub } from './live.ts'
import type { Mailer } from './mail/types.ts'
import type { RouteTable } from './route-table/types.ts'
import type { Store, User } from './store/types.ts'

export interface Clock {
  now(): Date
}

export interface Deps {
  config: Config
  store: Store
  blobs: Blobs
  routeTable: RouteTable
  clock: Clock
  /** The instance's sign-in (generic OIDC, from config); null/absent → none (dev-login only). */
  identity?: IdentityProvider | null
  /**
   * The live rooms' hub (live.ts): what the core publishes to a site's room through. Absent: an
   * instance without live rooms, where publishing does nothing.
   */
  live?: LiveHub
  /**
   * The provider email goes out through (mail/types.ts), when the instance has a mail driver
   * (`config.mail`). Absent: no email channel.
   */
  mailer?: Mailer
  /** outbound fetch (OAuth Client ID Metadata Documents); defaults to global fetch */
  fetch?: typeof fetch
  /**
   * Remote MCP: wait until a new site / share link is routed by the edge (`url` with the served
   * version's `paths`). Default: poll for up to READY_TIMEOUT_LAMBDA_MS, skipped by FLING_NO_WAIT
   * and in tests.
   */
  waitReady?: (url: string, paths: readonly string[]) => Promise<{ ready: boolean }>
}

export type AuthVia = 'session' | 'api_key' | 'oauth'

export interface AppEnv {
  Variables: {
    deps: Deps
    user: User
    via: AuthVia
    /** the session's claims (session auth only) */
    session: SessionClaims | undefined
    /** the admin acting as `user`, while impersonating (session auth only) */
    impersonator: string | undefined
  }
}

export const systemClock: Clock = { now: () => new Date() }
