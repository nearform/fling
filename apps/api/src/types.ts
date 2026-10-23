import type { Config } from './config.ts'
import type { Kvs } from './kvs/types.ts'
import type { Storage } from './storage/types.ts'
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
  storage: Storage
  kvs: Kvs
  clock: Clock
  /** defaults to the arctic Google client built from config */
  oauth?: OAuthClient
  /** outbound fetch (OAuth Client ID Metadata Documents); defaults to global fetch */
  fetch?: typeof fetch
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
