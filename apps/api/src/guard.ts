/**
 * The server-side half of "Fling never publishes dotfiles, secret files or secrets". The CLI and
 * the local MCP server check the same rules first (that's UX: early, specific messages); these
 * checks are the guarantee — they also hold for old CLIs, custom scripts and inline publishes.
 *
 * - Paths: every deploy manifest is refused (400) if a path is a dotfile / in a dot-directory
 *   (`dotfile`) or a secret file by name (`secret_file`).
 * - Contents: remote MCP publishes are scanned before anything is written; presigned uploads
 *   (bytes the server never saw) are read back and scanned at finalize, before the version goes
 *   live. Any finding → 422 `secret_detected`; the uploaded objects are deleted.
 */
import {
  describeSecretFindings,
  forbiddenPathReason,
  isScannablePath,
  MAX_DEPLOY_BYTES,
  type ManifestFile,
  NEVER_PUBLISHED_NOTE,
  SECRET_SCAN_MAX_FILE_BYTES,
  type SecretFinding,
  scanBytesForSecrets,
  siteObjectKey,
} from '@fling/shared'
import { mapLimit } from './lib/concurrency.ts'
import { ApiError } from './lib/errors.ts'
import type { Deps } from './types.ts'

const MAX_LISTED = 20
/** Objects read back in parallel at finalize. */
const SCAN_CONCURRENCY = 8
/** Upper bound on bytes read back per finalize (= the deploy limit, so in practice all of it). */
export const MAX_SCANNED_BYTES = MAX_DEPLOY_BYTES

const list = (paths: readonly string[]) =>
  paths.slice(0, MAX_LISTED).join(', ') +
  (paths.length > MAX_LISTED ? ` (+${paths.length - MAX_LISTED} more)` : '')

/** 400 `dotfile` / `secret_file` if any path can never be published. Accepts unvalidated input. */
export function assertPublishablePaths(paths: readonly unknown[]): void {
  const dotfiles: string[] = []
  const secretFiles: string[] = []
  for (const p of paths) {
    if (typeof p !== 'string') continue
    const reason = forbiddenPathReason(p)
    if (reason === 'dotfile') dotfiles.push(p)
    else if (reason === 'secret_file') secretFiles.push(p)
  }
  if (secretFiles.length > 0) {
    throw new ApiError(
      400,
      'secret_file',
      `Refusing to publish secret files (keys, certificates, credentials): ${list(secretFiles)}. ${NEVER_PUBLISHED_NOTE} Remove them and deploy again.`,
      { paths: secretFiles }
    )
  }
  if (dotfiles.length > 0) {
    throw new ApiError(
      400,
      'dotfile',
      `Refusing to publish dotfiles: ${list(dotfiles)}. ${NEVER_PUBLISHED_NOTE} Remove them and deploy again.`,
      { paths: dotfiles }
    )
  }
}

/** 422 `secret_detected`: which file and line, and what kind of secret — never the value. */
export function secretDetected(findings: readonly SecretFinding[]): ApiError {
  return new ApiError(
    422,
    'secret_detected',
    `Not published: found secrets in ${new Set(findings.map(f => f.path)).size} file(s) — ` +
      `${describeSecretFindings(findings, MAX_LISTED).join('; ')}. ${NEVER_PUBLISHED_NOTE} ` +
      'Remove the secret (and rotate it if it was ever shared), then deploy again.',
    { findings: findings.map(({ path, line, rule }) => ({ path, line, rule })) }
  )
}

/** Scan in-memory files (remote MCP publishes) before anything is written. */
export function assertNoSecrets(files: Iterable<readonly [string, Uint8Array]>): void {
  const findings: SecretFinding[] = []
  for (const [path, bytes] of files) findings.push(...scanBytesForSecrets(bytes, path))
  if (findings.length > 0) throw secretDetected(findings)
}

/**
 * Read back a pending version's uploaded objects and scan them: text-like files up to
 * SECRET_SCAN_MAX_FILE_BYTES, at most MAX_SCANNED_BYTES in total, SCAN_CONCURRENCY at a time.
 */
export async function scanStoredVersion(
  deps: Deps,
  siteId: string,
  versionId: string,
  files: readonly ManifestFile[]
): Promise<SecretFinding[]> {
  let budget = MAX_SCANNED_BYTES
  const toScan = files.filter(f => {
    if (!isScannablePath(f.path) || f.size > SECRET_SCAN_MAX_FILE_BYTES || f.size === 0)
      return false
    if (f.size > budget) return false
    budget -= f.size
    return true
  })
  const results = await mapLimit(toScan, SCAN_CONCURRENCY, async f => {
    const bytes = await deps.storage.get(siteObjectKey(siteId, versionId, f.path))
    return bytes ? scanBytesForSecrets(bytes, f.path) : []
  })
  return results.flat()
}
