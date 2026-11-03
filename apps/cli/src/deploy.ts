/**
 * Deploy a folder: build the manifest, ask the API what to do, upload only what it asks for
 * straight to S3 (presigned PUTs, 8 at a time, 3 retries with backoff), then finalize.
 *
 * With `path` (a path publish, `pathPublish` capability) the folder becomes that folder of the
 * site: every file is sent as `<path>/<file>` and the server keeps the rest of the site. When
 * someone else publishes the site meanwhile, the server answers 409 `base_changed`; the whole
 * deploy then runs once more, on top of what they published.
 *
 * With `base` (a folder pulled with `fling pull`, pull.ts; the `pull` capability) the deploy builds
 * on the version pulled: the server uploads only what it doesn't have and refuses with 409
 * `base_changed` if the site has moved on. That is never retried: only the user knows how their
 * changes and the newer version go together (`BaseChangedError`).
 */
import { readFile } from 'node:fs/promises'
import {
  type AccessLevel,
  type AudienceInput,
  DeployResponseSchema,
  FinalizeResponseSchema,
  type FormsConfig,
  isValidSiteName,
  SITE_NAME_MAX,
  type Site,
  slugify,
} from '@fling/shared'
import { type ApiClient, CliApiError, type FetchLike, putUpload, UploadError } from './api.ts'
import { CliError } from './errors.ts'
import {
  buildManifest,
  type LocalFile,
  type LocalManifest,
  mapLimit,
  toManifest,
} from './manifest.ts'
import { defaultSiteName } from './naming.ts'
import { checkName } from './sites.ts'

export { defaultSiteName }

/** The name belongs to someone else (409 `name_taken`, or a name check said `taken`). */
export class NameTakenError extends CliError {
  readonly code = 'name_taken'
  constructor(
    readonly siteName: string,
    readonly suggestions: string[],
    hint?: string
  ) {
    super(
      `The site name "${siteName}" is taken by someone else` +
        (suggestions.length ? `. Free alternatives: ${suggestions.join(', ')}` : ''),
      {
        hint:
          hint ??
          `Pass --name <name> to choose another${suggestions[0] ? `, e.g. --name ${suggestions[0]}` : ''}.`,
      }
    )
    this.name = 'NameTakenError'
  }
}

/** Suggestions from a 409 body (`error.suggestions`), else asked of GET /api/names/:name. */
async function nameTakenError(client: ApiClient, name: string, body: unknown) {
  const raw = (body as { error?: { suggestions?: unknown } } | undefined)?.error?.suggestions
  let suggestions = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : []
  if (suggestions.length === 0) {
    suggestions = await checkName(client, name)
      .then(c => c.suggestions)
      .catch(() => [])
  }
  return new NameTakenError(name, suggestions)
}

/** The site moved on since the version a deploy builds on (`base`): someone published since. */
export class BaseChangedError extends CliError {
  readonly code = 'base_changed'
  constructor(
    readonly siteName: string,
    readonly base: string,
    hint?: string
  ) {
    super(
      `${siteName} has changed since you pulled it (version ${base}): someone published it since`,
      {
        hint:
          hint ??
          'Pull it again into another folder, redo your changes there and deploy that, or deploy with --force to replace what they published.',
      }
    )
    this.name = 'BaseChangedError'
  }
}

export const UPLOAD_CONCURRENCY = 8
export const UPLOAD_RETRIES = 3

export function resolveSiteName(dir: string, name?: string): string {
  if (name !== undefined) {
    if (!isValidSiteName(name)) {
      throw new CliError(`Invalid site name "${name}"`, {
        hint: `Use lowercase letters, digits and single hyphens, up to ${SITE_NAME_MAX} characters (e.g. "${slugify(name) || 'my-site'}").`,
      })
    }
    return name
  }
  const derived = defaultSiteName(dir)
  if (!isValidSiteName(derived)) {
    throw new CliError(`Could not derive a site name from "${dir}"`, {
      hint: 'Pass --name <name>.',
    })
  }
  return derived
}

export interface DeployOptions {
  dir: string
  name?: string
  spa?: boolean
  public?: boolean
  /**
   * Who can open the site if this deploy creates it (with `audience` for groups and people);
   * omitted, the instance's default. A site that has been live keeps its access.
   */
  access?: AccessLevel
  audience?: AudienceInput
  /** A path publish: the folder of the site (normalised, `normalizePublishPath`) to replace. */
  path?: string
  /** Publish on this version (it must still be current): what a pulled folder deploys on. */
  base?: string
  /** With `base`: the files are only part of the site, and `remove` the site paths to delete. */
  partial?: boolean
  remove?: string[]
  /** With `partial`: the folder is this folder of the site (a pull of one folder). */
  within?: string
  /** The new version's forms config (null: none); omitted, as DeployRequest.forms (forms.ts). */
  forms?: FormsConfig | null
  /** A manifest already built from `dir` (so the caller can inspect it before deploying). */
  manifest?: LocalManifest
  onProgress?: (event: {
    uploaded: number
    total: number
    bytes: number
    totalBytes: number
  }) => void
}

export interface DeployDeps {
  client: ApiClient
  /** For the presigned PUTs (no auth header). */
  fetch: FetchLike
  sleep?: (ms: number) => Promise<void>
}

export interface DeployResult {
  status: 'unchanged' | 'repointed' | 'live'
  name: string
  url: string
  versionId: string
  site: Site
  fileCount: number
  totalBytes: number
  /** files actually uploaded (0 unless status is `live`) */
  uploaded: number
  warnings: string[]
  /** this deploy made the site live for the first time: a new site, its access just set */
  first: boolean
  /** a path publish: the folder it replaced */
  path?: string
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

const baseChanged = (error: unknown) =>
  error instanceof CliApiError && error.status === 409 && error.code === 'base_changed'

export async function deploy(deps: DeployDeps, opts: DeployOptions): Promise<DeployResult> {
  const name = resolveSiteName(opts.dir, opts.name)
  const local = opts.manifest ?? (await buildManifest(opts.dir))
  try {
    return await deployOnce(deps, opts, name, local)
  } catch (error) {
    if (opts.path === undefined || !baseChanged(error)) throw error
    return deployOnce(deps, opts, name, local)
  }
}

async function deployOnce(
  deps: DeployDeps,
  opts: DeployOptions,
  name: string,
  local: LocalManifest
): Promise<DeployResult> {
  const onBaseChanged = (error: unknown) =>
    opts.base !== undefined && baseChanged(error) ? new BaseChangedError(name, opts.base) : error
  const folder = opts.path
  const prefix = folder ?? opts.within
  const sitePath = (file: string) => (prefix === undefined ? file : `${prefix}/${file}`)
  const base = {
    name,
    fileCount: local.files.length,
    totalBytes: local.totalBytes,
    warnings: local.warnings,
    ...(folder === undefined ? {} : { path: folder }),
  }
  const path = `/api/sites/${encodeURIComponent(name)}/deploys`
  const manifest = toManifest(local)
  const res = await deps.client
    .request('POST', path, {
      schema: DeployResponseSchema,
      body: {
        manifest: { files: manifest.files.map(f => ({ ...f, path: sitePath(f.path) })) },
        ...(folder === undefined ? {} : { path: folder }),
        ...(opts.base === undefined
          ? {}
          : {
              base: opts.base,
              ...(opts.partial ? { partial: true, remove: opts.remove ?? [] } : {}),
            }),
        ...(opts.spa !== undefined ? { spa: opts.spa } : {}),
        ...(opts.public ? { visibility: 'public' as const } : {}),
        ...(opts.access ? { access: opts.access } : {}),
        ...(opts.audience ? { audience: opts.audience } : {}),
        ...(opts.forms === undefined ? {} : { forms: opts.forms }),
      },
    })
    .catch(async (error: unknown) => {
      if (error instanceof CliApiError && error.status === 409 && error.code === 'name_taken')
        throw await nameTakenError(deps.client, name, error.body)
      throw onBaseChanged(error)
    })
  if (res.status !== 'upload') {
    return {
      ...base,
      status: res.status,
      url: res.site.url,
      versionId: res.versionId,
      site: res.site,
      uploaded: 0,
      first: false,
    }
  }

  const byPath = new Map(local.files.map(f => [sitePath(f.path), f]))
  const uploads = res.uploads.map(u => {
    const file = byPath.get(u.path)
    if (!file) throw new CliError(`Server asked for a file that is not in the manifest: ${u.path}`)
    return { ...u, file }
  })
  const totalBytes = uploads.reduce((n, u) => n + u.file.size, 0)
  let done = 0
  let bytes = 0
  opts.onProgress?.({ uploaded: 0, total: uploads.length, bytes: 0, totalBytes })
  await mapLimit(uploads, UPLOAD_CONCURRENCY, async u => {
    await uploadWithRetry(deps, u.file, u.url, u.headers)
    done++
    bytes += u.file.size
    opts.onProgress?.({ uploaded: done, total: uploads.length, bytes, totalBytes })
  })

  const fin = await deps.client
    .request('POST', `${path}/${encodeURIComponent(res.versionId)}/finalize`, {
      schema: FinalizeResponseSchema,
    })
    .catch((error: unknown) => {
      throw onBaseChanged(error)
    })
  return {
    ...base,
    status: 'live',
    url: fin.site.url,
    versionId: fin.versionId,
    site: fin.site,
    uploaded: uploads.length,
    first: fin.first === true,
  }
}

async function uploadWithRetry(
  deps: DeployDeps,
  file: LocalFile,
  url: string,
  headers: Record<string, string>
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep
  const body = file.content ?? (await readFile(file.absPath))
  for (let attempt = 0; ; attempt++) {
    try {
      await putUpload(deps.fetch, url, headers, body)
      return
    } catch (error) {
      const retryable = error instanceof UploadError && error.retryable
      if (!retryable || attempt >= UPLOAD_RETRIES) {
        throw new CliError(`Upload of ${file.path} failed: ${(error as Error).message}`, {
          hint: retryable ? 'Check your connection and run the deploy again.' : undefined,
        })
      }
      await sleep(500 * 2 ** attempt)
    }
  }
}
