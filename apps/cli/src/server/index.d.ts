// Types for the CLI package's `/server` export (SERVER_HELPER_MODULE), the helpers a site server
// imports: who is calling, the version's own files and its site secrets. Self-contained, because it ships in the npm package
// (dist/server.d.ts) without the workspace's packages; tests/server-helper.test.ts checks it
// against FlingServerHelpers in @fling/shared, the contract every platform's implementation keeps.
//
// The implementation in the package is the Node one (dist/helper.mjs), for `fling dev` and tests.
// A deployed bundle keeps the import as it is, and the platform that runs it resolves it to its own.

/** Who is calling: from the visitor's sign-in, never from the browser. */
export interface Viewer {
  /** the viewer id: the same for one person on one site, different on every other site */
  id: string
  email: string
  /** invited from outside the organisation, as a reviewer */
  guest: boolean
}

/** A Node request (IncomingMessage) or anything else with Node-style headers. */
export interface NodeRequestLike {
  headers: Record<string, string | string[] | undefined>
}

/**
 * Who is calling, from a fetch Request or a Node IncomingMessage; null on a public site, through a
 * share link, or with no one signed in.
 */
export declare function viewer(request: Request | NodeRequestLike): Viewer | null

/**
 * One of this version's published files, as a Response: 404 for a file it doesn't have, a
 * dotfile, anything under `_fling/` or outside the version.
 */
export declare function file(path: string): Promise<Response>

/** A site secret (`process.env.NAME`); throws, naming it, when it isn't set. */
export declare function secret(name: string): string

declare const helpers: {
  viewer: typeof viewer
  file: typeof file
  secret: typeof secret
}
export default helpers
