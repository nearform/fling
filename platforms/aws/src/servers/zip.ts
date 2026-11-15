/**
 * A version's Web Function zip: the server runtime at its root (index.mjs, the entry Lambda
 * starts, with entry.mjs and helper.mjs: scripts/server-entry.mjs), the author's bundle as
 * server.mjs, and the version's own files under files/ for `file()`. The files come from the
 * version's manifest in Blobs, never a listing, and leave out what `file()` never serves (dotfiles,
 * anything under _fling/). A server reads its files from the zip because the server's role has no
 * access to Fling's storage; past FILES_MAX_BYTES the rest are left out, and `file()` answers 404
 * for them.
 */
import { readFile } from 'node:fs/promises'
import type { Blobs } from '@fling/api/blobs'
import { manifestKey } from '@fling/api/blobs'
import type { ServerSite, ServerVersion } from '@fling/api/servers/types'
import { serverFilePath } from '@fling/shared/site-server'
import { type Zippable, zipSync } from 'fflate'
import { ENTRY_BUNDLE, ENTRY_FILE, ENTRY_FILES_DIR } from './entry-contract.ts'

/** The most bytes of a version's files a zip carries. */
export const FILES_MAX_BYTES = 50 * 1024 * 1024
const CONCURRENCY = 16
/** Kept as they are: compressing them again gains nothing. */
const STORED = /\.(png|jpe?g|gif|webp|avif|ico|woff2?|zip|gz|br|mp4|webm|mp3|pdf)$/i

/** The server runtime's three files, by their name in the zip. */
export type ServerRuntime = Record<string, Uint8Array>

/** The runtime from a directory scripts/server-entry.mjs wrote (the API's zip: server-entry/). */
export async function loadServerRuntime(dir: URL): Promise<ServerRuntime> {
  const out: ServerRuntime = {}
  for (const name of [ENTRY_FILE, 'entry.mjs', 'helper.mjs']) {
    out[name] = new Uint8Array(await readFile(new URL(name, dir)))
  }
  return out
}

interface Manifest {
  files?: { path: string; size?: number }[]
}

/** The zip of one version's server. */
export async function revisionZip(
  blobs: Blobs,
  runtime: ServerRuntime,
  site: ServerSite,
  version: ServerVersion
): Promise<{ zip: Uint8Array; skipped: number }> {
  const bundle = await blobs.get(version.bundle)
  if (!bundle) throw new Error(`No server bundle at ${version.bundle}`)
  const entries: Zippable = { [ENTRY_BUNDLE]: bundle }
  for (const [name, bytes] of Object.entries(runtime)) entries[name] = bytes

  const manifest = await blobs.getJson<Manifest>(manifestKey(site.id, version.id))
  const wanted: string[] = []
  let total = 0
  let skipped = 0
  for (const f of manifest?.files ?? []) {
    const path = serverFilePath(f.path)
    if (!path) continue
    total += f.size ?? 0
    if (total > FILES_MAX_BYTES) skipped++
    else wanted.push(path)
  }
  const files: Record<string, Uint8Array> = {}
  for (let i = 0; i < wanted.length; i += CONCURRENCY) {
    await Promise.all(
      wanted.slice(i, i + CONCURRENCY).map(async path => {
        const bytes = await blobs.get(`${version.files}${path}`)
        if (bytes) files[path] = bytes
      })
    )
  }
  for (const [path, bytes] of Object.entries(files)) {
    entries[`${ENTRY_FILES_DIR}/${path}`] = [bytes, { level: STORED.test(path) ? 0 : 6 }]
  }
  return { zip: zipSync(entries, { level: 6 }), skipped }
}
