import type { Blobs } from './blobs/types.ts'
import type { Config } from './config.ts'
import type { RouteTable } from './route-table/types.ts'
import type { Store, User } from './store/types.ts'

export interface Clock {
  now(): Date
}

/** The verified claims we need from Google's ID token. */
export interface GoogleClaims {
  sub?: string
  email?: string
  email_verified?: boolean
  hd?: string
  name?: string
  picture?: string
}

/** Thin seam over arctic so tests can fake Google. */
export interface OAuthClient {
  authorizationUrl(state: string, verifier: string): URL
  exchange(code: string, verifier: string): Promise<GoogleClaims>
}

export interface Deps {
  config: Config
  store: Store
  blobs: Blobs
  routeTable: RouteTable
  clock: Clock
  /** defaults to the arctic Google client built from config */
  oauth?: OAuthClient
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
  }
}

export const systemClock: Clock = { now: () => new Date() }
