/**
 * Record evolution: every item `Records` writes carries `v`, the version of its kind's shape.
 * Items written before versioning have no `v` and are version 1.
 *
 * - Additive changes (a new optional field) need no new version: old items simply lack the field.
 * - A breaking change (rename, change of meaning) appends an upgrade to its kind in `UPGRADES`.
 *   Reads upgrade old items step by step; writes always write the current version. Bulk rewrites
 *   are data migrations, not this.
 * - Readers accept items one version ahead of them (written by a newer deploy during a rollout):
 *   fields they don't know pass through untouched. Two or more ahead is an error.
 */

/** Each kind of item, as stored in its `type` attribute (the API-key lookup item has none). */
export type Kind =
  | 'user'
  | 'userindex'
  | 'audit'
  | 'slug'
  | 'apikey'
  | 'apikeyref'
  | 'name'
  | 'site'
  | 'version'
  | 'comment'
  | 'oauthclient'
  | 'oauthreq'
  | 'oauthcode'
  | 'grant'
  | 'refresh'
  | 'upload'
  | 'uploadfile'

export type Fields = Record<string, unknown>
export type Upgrade = (fields: Fields) => Fields

/**
 * `UPGRADES[kind][n - 1]` turns a version-n record of `kind` into version n+1, so a kind's
 * current version is its number of upgrades + 1. None yet: every kind is at version 1.
 */
export const UPGRADES: Partial<Record<Kind, readonly Upgrade[]>> = {}

export const currentVersion = (kind: Kind, upgrades = UPGRADES) => (upgrades[kind]?.length ?? 0) + 1

/** The stored item for a record: key, `type` (except the API-key lookup), fields, `v`. */
export function encode<K extends { pk: string; sk: string }>(
  kind: Kind,
  key: K,
  fields: object,
  upgrades = UPGRADES
) {
  return {
    ...key,
    ...(kind === 'apikeyref' ? {} : { type: kind }),
    ...fields,
    v: currentVersion(kind, upgrades),
  }
}

/** The record in a stored item: key, `type` and `v` stripped, upgraded to the current version. */
export function decode<T>(kind: Kind, item: Fields, upgrades = UPGRADES): T {
  const { pk: _pk, sk: _sk, type: _type, v, ...fields } = item
  const current = currentVersion(kind, upgrades)
  let version = typeof v === 'number' ? v : 1
  if (version > current + 1) {
    throw new Error(`A ${kind} record is v${version}; this code reads up to v${current + 1}`)
  }
  const steps = upgrades[kind] ?? []
  let out = fields
  for (; version < current; version++) out = (steps[version - 1] as Upgrade)(out)
  return out as T
}
