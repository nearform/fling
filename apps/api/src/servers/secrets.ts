/**
 * Site secrets: values a site's server reads as `process.env.NAME`, set by the site's owners and
 * publishers (`site.secrets`), never returned by the API. They belong to the site, not a version,
 * so a rollback runs the old code with today's secrets. A version declares the ones it needs
 * (`fling.json` `secrets`); only those reach its server, and a publish or rollback to it while any
 * is unset is 409 `secrets_missing` (servers/index.ts).
 *
 * Stored in the Table (`SITE#<siteId>/SECRET#<name>`, Records) sealed with AES-256-GCM under a key
 * derived from the instance's SESSION_SECRET (HMAC-SHA256 over a fixed label), with the site id and
 * the name as associated data, so a sealed value moved to another site or name does not open.
 * Rotating SESSION_SECRET makes every stored secret unreadable: they must be set again. At most
 * SITE_SECRETS_MAX per site, SITE_SECRET_MAX_BYTES each.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import {
  SITE_SECRET_MAX_BYTES,
  SITE_SECRET_NAME_RE,
  SITE_SECRETS_MAX,
  type SiteSecret,
  type SiteSecretsResponse,
} from '@fling/shared'
import { ApiError, badRequest, notFound } from '../lib/errors.ts'
import type { SiteRecord, SiteSecretRecord } from '../store/types.ts'
import type { Deps } from '../types.ts'

const LABEL = 'fling:site-secrets:v1'
const IV_BYTES = 12
const TAG_BYTES = 16

const keyOf = (deps: Pick<Deps, 'config'>) =>
  createHmac('sha256', deps.config.secrets.sessionSecret).update(LABEL).digest()

const aad = (siteId: string, name: string) => Buffer.from(`${siteId}\n${name}`)

/** A secret's value, sealed for one site and name. */
export function sealSecret(
  deps: Pick<Deps, 'config'>,
  siteId: string,
  name: string,
  value: string
): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', keyOf(deps), iv)
  cipher.setAAD(aad(siteId, name))
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')
}

/** A sealed value opened, or null when it doesn't open (another key, site or name). */
export function openSecret(
  deps: Pick<Deps, 'config'>,
  siteId: string,
  name: string,
  sealed: string
): string | null {
  try {
    const raw = Buffer.from(sealed, 'base64url')
    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(raw.length - TAG_BYTES)
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', keyOf(deps), iv)
    decipher.setAAD(aad(siteId, name))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

const listed = (r: SiteSecretRecord): SiteSecret => ({
  name: r.name,
  setBy: r.setBy,
  setAt: r.setAt,
})

/** 400 `invalid_secret_name` unless `name` is one a server can read from its environment. */
export function checkSecretName(name: string) {
  if (!SITE_SECRET_NAME_RE.test(name)) {
    throw badRequest(
      `"${name}" can't be a secret's name: use A-Z, 0-9 and _, not starting with a digit, at most 64 characters`,
      'invalid_secret_name'
    )
  }
}

/** The site's secrets by name, who set each and when; the names `declared` asks for, and those unset. */
export async function listSecrets(
  deps: Deps,
  site: SiteRecord,
  declared: readonly string[]
): Promise<SiteSecretsResponse> {
  const records = await deps.store.listSiteSecrets(site.id)
  const names = new Set(records.map(r => r.name))
  return {
    secrets: records.map(listed),
    declared: [...declared],
    missing: declared.filter(n => !names.has(n)),
  }
}

/**
 * Set a secret: 400 `invalid_secret_name`, 413 `too_large` over SITE_SECRET_MAX_BYTES, 409
 * `too_many_secrets` for a new name once the site has SITE_SECRETS_MAX.
 */
export async function setSecret(
  deps: Deps,
  site: SiteRecord,
  name: string,
  value: string,
  by: string
): Promise<SiteSecret> {
  checkSecretName(name)
  if (Buffer.byteLength(value, 'utf8') > SITE_SECRET_MAX_BYTES) {
    throw new ApiError(
      413,
      'too_large',
      `A secret's value is at most ${SITE_SECRET_MAX_BYTES / 1024} KB: secrets are for keys and URLs, not data`
    )
  }
  const record: SiteSecretRecord = {
    siteId: site.id,
    name,
    sealed: sealSecret(deps, site.id, name, value),
    setBy: by,
    setAt: deps.clock.now().toISOString(),
  }
  if (!(await deps.store.putSiteSecret(record, SITE_SECRETS_MAX))) {
    throw new ApiError(
      409,
      'too_many_secrets',
      `"${site.name}" has ${SITE_SECRETS_MAX} secrets, the most a site may have: remove one first`
    )
  }
  return listed(record)
}

/** Remove a secret; 404 when the site has none by that name. */
export async function removeSecret(deps: Deps, site: SiteRecord, name: string) {
  if (!(await deps.store.deleteSiteSecret(site.id, name))) {
    throw notFound(`"${site.name}" has no secret named ${name}`)
  }
}

/**
 * The values of `names` the site has set (a secret whose value no longer opens counts as unset),
 * and the names it lacks.
 */
export async function secretValues(
  deps: Deps,
  siteId: string,
  names: readonly string[]
): Promise<{ values: Record<string, string>; missing: string[] }> {
  if (names.length === 0) return { values: {}, missing: [] }
  const records = new Map((await deps.store.listSiteSecrets(siteId)).map(r => [r.name, r]))
  const values: Record<string, string> = {}
  const missing: string[] = []
  for (const name of names) {
    const r = records.get(name)
    const value = r ? openSecret(deps, siteId, name, r.sealed) : null
    if (value === null) missing.push(name)
    else values[name] = value
  }
  return { values, missing }
}
