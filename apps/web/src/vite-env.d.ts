/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The app's origin, used by the standalone 404's "Back to Fling home" link. */
  readonly VITE_APP_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
