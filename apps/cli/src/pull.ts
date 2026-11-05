/**
 * Pull: download a site's files into a folder, to change some or all of them and deploy again on
 * top of the version pulled (`fling pull`, and the local MCP's `fling_pull`; the `pull`
 * capability). The API answers with each file's path, SHA-256 and a short-lived signed URL; the
 * bytes come straight from storage, 8 at a time, and each is checked against its hash.
 *
 * The folder gets a **site link**, `.fling-site.json`: the server, the site, the version pulled and
 * the hash of every file pulled. It is a dotfile, so the manifest walker never publishes it. A
 * deploy of the folder reads it (`onLink`): it publishes to that site on that server, on the
 * version pulled as its base, so the server refuses it (409 `base_changed`) if someone published
 * since rather than overwrite their work. The whole folder is deployed (the server uploads only
 * what changed): to the site, or after a pull of one of its Paths (`path`), to that Path.
 *
 * A version with forms (forms.ts) comes with its config: the pull writes it as `fling.forms.json`
 * at the top of the folder and records its hash in the link (`forms`), so a deploy after it was
 * deleted removes the forms (forms.ts in the CLI). It is never one of the link's `files`.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  FORMS_FILE,
  isValidSitePath,
  PULL_URL_TTL_SECONDS,
  type PullFile,
  PullResponseSchema,
} from '@fling/shared'
import { z } from 'zod'
import type { ApiClient, FetchLike } from './api.ts'
import { CliError } from './errors.ts'
import { mapLimit } from './manifest.ts'

/** What the link needs of a folder's manifest: each file's path and hash. */
type Hashed = { files: readonly { path: string; sha256: string }[] }

export const SITE_LINK_FILE = '.fling-site.json'

export const DOWNLOAD_CONCURRENCY = 8
const DOWNLOAD_RETRIES = 3

const SiteLinkSchema = z.object({
  /** the Fling it was pulled from */
  server: z.string(),
  name: z.string(),
  /** the version pulled, or the one the last deploy made */
  versionId: z.string(),
  /** a pull of one of the site's Paths (its folder): the folder is that Path */
  path: z.string().optional(),
  /** every file pulled (or deployed), by site path: its SHA-256 */
  files: z.record(z.string(), z.string()),
  /** the SHA-256 of the fling.forms.json pulled (or deployed); absent when the version had none */
  forms: z.string().optional(),
})
export type SiteLink = z.infer<typeof SiteLinkSchema>

/** The folder's site link; null when it has none. */
export async function readSiteLink(dir: string): Promise<SiteLink | null> {
  let raw: string
  try {
    raw = await readFile(join(dir, SITE_LINK_FILE), 'utf8')
  } catch {
    return null
  }
  try {
    return SiteLinkSchema.parse(JSON.parse(raw))
  } catch {
    throw new CliError(`${join(dir, SITE_LINK_FILE)} is not a site link Fling can read`, {
      hint: 'Delete it to deploy the folder as a plain folder, or pull the site again.',
    })
  }
}

export async function writeSiteLink(dir: string, link: SiteLink): Promise<void> {
  await writeFile(join(dir, SITE_LINK_FILE), `${JSON.stringify(link, null, 2)}\n`)
}

/** What a deploy of a linked folder changes, against the files pulled. */
export interface LinkChanges {
  changed: string[]
  added: string[]
  removed: string[]
}

/** The folder's files by site path: their SHA-256. */
const siteFiles = (link: Pick<SiteLink, 'path'>, local: Hashed) =>
  Object.fromEntries(
    local.files.map(f => [link.path === undefined ? f.path : `${link.path}/${f.path}`, f.sha256])
  )

/**
 * How to deploy a linked folder: all of it, on the version pulled, to the site or (after a pull
 * of one of its Paths, `path`) to that Path; and what changed, for the summary.
 */
export function onLink(link: SiteLink, local: Hashed) {
  const now = siteFiles(link, local)
  const changes: LinkChanges = { changed: [], added: [], removed: [] }
  for (const [path, sha] of Object.entries(now)) {
    const was = link.files[path]
    if (was === undefined) changes.added.push(path)
    else if (was !== sha) changes.changed.push(path)
  }
  for (const path of Object.keys(link.files)) if (!(path in now)) changes.removed.push(path)
  return {
    base: link.versionId,
    ...(link.path === undefined ? {} : { path: link.path }),
    changes,
  }
}

/**
 * The link after a deploy made `versionId` current with the folder's files, and its forms file
 * (`forms`, its hash; undefined: the folder has none).
 */
export const linkAfter = (
  link: SiteLink,
  versionId: string,
  local: Hashed,
  forms?: string
): SiteLink => {
  const { forms: _was, ...rest } = link
  return { ...rest, versionId, files: siteFiles(link, local), ...(forms ? { forms } : {}) }
}

/** "2 changed, 1 added, 1 removed", or "no changes". */
export function describeChanges(c: LinkChanges): string {
  const parts = [
    c.changed.length ? `${c.changed.length} changed` : '',
    c.added.length ? `${c.added.length} added` : '',
    c.removed.length ? `${c.removed.length} removed` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : 'no changes'
}

export interface PullOptions {
  name: string
  /** where to write the files */
  dir: string
  /** another version than the current one (owners, publishers and admins) */
  versionId?: string
  /** only this folder of the site (normalised), written at the top of `dir` */
  path?: string
  /** write into a folder that is not empty */
  force?: boolean
  onProgress?: (event: { done: number; total: number; bytes: number; totalBytes: number }) => void
}

export interface PullResult {
  server: string
  name: string
  dir: string
  versionId: string
  path?: string
  fileCount: number
  totalBytes: number
  /** the version has forms: written as fling.forms.json */
  forms: boolean
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Pull the site into `dir` and write its site link. */
export async function pullSite(
  deps: { client: ApiClient; fetch: FetchLike; sleep?: (ms: number) => Promise<void> },
  opts: PullOptions
): Promise<PullResult> {
  const existing = await stat(opts.dir).catch(() => null)
  if (existing && !existing.isDirectory()) throw new CliError(`${opts.dir} is not a folder`)
  const entries = existing ? await readdir(opts.dir) : []
  if (entries.length > 0 && !opts.force) {
    throw new CliError(`${opts.dir} is not empty`, {
      hint: 'Pull into a new folder, or pass --force to write the files over what is there.',
    })
  }
  const before = entries.includes(SITE_LINK_FILE) ? await readSiteLink(opts.dir) : null

  const pulled = await deps.client.request(
    'GET',
    `/api/sites/${encodeURIComponent(opts.name)}/pull`,
    {
      schema: PullResponseSchema,
      query: { version: opts.versionId, path: opts.path },
    }
  )
  const prefix = opts.path === undefined ? '' : `${opts.path}/`
  const local = (f: PullFile) => {
    const rel = f.path.slice(prefix.length)
    if (!f.path.startsWith(prefix) || !isValidSitePath(rel)) {
      throw new CliError(`The server sent a file outside the site: ${f.path}`)
    }
    return rel
  }
  const totalBytes = pulled.files.reduce((n, f) => n + f.size, 0)
  let done = 0
  let bytes = 0
  await mkdir(opts.dir, { recursive: true })
  opts.onProgress?.({ done, total: pulled.files.length, bytes, totalBytes })
  await mapLimit(pulled.files, DOWNLOAD_CONCURRENCY, async f => {
    const target = join(opts.dir, local(f))
    const body = await download(deps, f)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body)
    done++
    bytes += f.size
    opts.onProgress?.({ done, total: pulled.files.length, bytes, totalBytes })
  })
  let forms: string | undefined
  if (pulled.forms) {
    const bytes = Buffer.from(`${JSON.stringify(pulled.forms, null, 2)}\n`)
    await writeFile(join(opts.dir, FORMS_FILE), bytes)
    forms = createHash('sha256').update(bytes).digest('hex')
  }
  // A pull over an earlier one of the same site: what it pulled that the site no longer has goes.
  if (before && before.server === deps.client.serverUrl && before.name === opts.name) {
    if (before.forms && !pulled.forms) await rm(join(opts.dir, FORMS_FILE), { force: true })
    const now = new Set(pulled.files.map(f => f.path))
    const beforePrefix = before.path === undefined ? '' : `${before.path}/`
    for (const path of Object.keys(before.files)) {
      if (now.has(path) || !path.startsWith(beforePrefix)) continue
      const rel = path.slice(beforePrefix.length)
      if (isValidSitePath(rel)) await rm(join(opts.dir, rel), { force: true })
    }
  }
  await writeSiteLink(opts.dir, {
    server: deps.client.serverUrl,
    name: opts.name,
    versionId: pulled.versionId,
    ...(pulled.path === undefined ? {} : { path: pulled.path }),
    files: Object.fromEntries(pulled.files.map(f => [f.path, f.sha256])),
    ...(forms ? { forms } : {}),
  })
  return {
    server: deps.client.serverUrl,
    name: opts.name,
    dir: opts.dir,
    versionId: pulled.versionId,
    ...(pulled.path === undefined ? {} : { path: pulled.path }),
    fileCount: pulled.files.length,
    totalBytes,
    forms: pulled.forms !== undefined,
  }
}

/** One file's bytes from its signed URL, retried on network and server errors, hash checked. */
async function download(
  deps: { fetch: FetchLike; sleep?: (ms: number) => Promise<void> },
  file: PullFile
): Promise<Uint8Array> {
  const sleep = deps.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt++) {
    let retryable = true
    let why: string
    try {
      const res = await deps.fetch(file.url, { signal: AbortSignal.timeout(5 * 60_000) })
      if (res.ok) {
        const body = new Uint8Array(await res.arrayBuffer())
        if (createHash('sha256').update(body).digest('hex') === file.sha256) return body
        why = 'the bytes do not match their hash'
      } else {
        await res.arrayBuffer().catch(() => {})
        retryable = res.status >= 500 || res.status === 408 || res.status === 429
        why = `HTTP ${res.status}`
      }
    } catch (error) {
      why = `network error (${(error as Error).message})`
    }
    if (!retryable || attempt >= DOWNLOAD_RETRIES) {
      throw new CliError(`Download of ${file.path} failed: ${why}`, {
        hint: retryable
          ? 'Check your connection and pull again.'
          : `Download links last ${PULL_URL_TTL_SECONDS / 60} minutes: pull again.`,
      })
    }
    await sleep(500 * 2 ** attempt)
  }
}
