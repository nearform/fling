// Node-only (uses node:crypto); kept out of index.ts so the browser bundle never pulls it in.
import { createHash } from 'node:crypto'
import { canonicalManifest, type ManifestFile, VERSION_ID_LENGTH } from './manifest.ts'

export function computeVersionId(files: readonly Pick<ManifestFile, 'path' | 'sha256'>[]): string {
  return createHash('sha256')
    .update(canonicalManifest(files))
    .digest('hex')
    .slice(0, VERSION_ID_LENGTH)
}
