/**
 * fling_read_files on the remote MCP server: a version's files, inline, for an agent that can't
 * download them. Who may read is pull's (`pullable`, pull.ts: `site.pull`); the paging, encoding
 * and wording are shared with the local server (read-files.ts in @fling/shared).
 */
import {
  encodeForAgent,
  MCP_READ_MAX_BYTES,
  pageOfFiles,
  type ReadFile,
  siteObjectKey,
} from '@fling/shared'
import { mapLimit } from '../lib/concurrency.ts'
import { conflict } from '../lib/errors.ts'
import { pullable } from '../pull.ts'
import type { User } from '../store/types.ts'
import type { Deps } from '../types.ts'
import { normalizeFolder } from './publish.ts'

const READ_CONCURRENCY = 8

export async function readFiles(
  deps: Deps,
  user: User,
  name: string,
  opts: { versionId?: string; path?: string; paths?: readonly string[]; cursor?: string }
): Promise<{
  name: string
  versionId: string
  path?: string
  files: ReadFile[]
  missing: string[]
  nextCursor?: string
}> {
  const path = opts.path === undefined ? undefined : normalizeFolder(opts.path)
  const { site, storage, versionId, files } = await pullable(deps, user, name, {
    ...(opts.versionId ? { versionId: opts.versionId } : {}),
    ...(path === undefined ? {} : { path }),
  })
  const { page, tooLarge, missing, nextCursor } = pageOfFiles(files, {
    paths: opts.paths,
    cursor: opts.cursor,
    budget: MCP_READ_MAX_BYTES,
  })
  const read = await mapLimit(page, READ_CONCURRENCY, async f => {
    const bytes = await deps.blobs.get(siteObjectKey(storage, versionId, f.path))
    if (!bytes) throw conflict(`"${f.path}" of version ${versionId} is missing`, 'missing_file')
    const { path: p, size, contentType, sha256 } = f
    return { path: p, size, contentType, sha256, ...encodeForAgent(f.path, bytes) }
  })
  const big = tooLarge.map(({ path: p, size, contentType, sha256 }) => ({
    path: p,
    size,
    contentType,
    sha256,
    tooLarge: true as const,
  }))
  return {
    name: site.name,
    versionId,
    ...(path === undefined ? {} : { path }),
    files: [...read, ...big].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    missing,
    ...(nextCursor ? { nextCursor } : {}),
  }
}
