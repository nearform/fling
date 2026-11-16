/**
 * Site secrets: values a site's server reads as `process.env.NAME`, set by the site's owners and
 * publishers (`site.secrets`), never returned by the API. They belong to the site, not a version,
 * so a rollback runs the old code with today's secrets. A version declares the ones it needs
 * (`fling.json` `secrets`); only those reach its server, and a publish or rollback to it while any
 * is unset is 409 `secrets_missing` (servers/index.ts).
 *
 * Stored in the Table (`SITE#<siteId>/SECRET#<name>`, Records) sealed with AES-256-GCM, with the
 * site id and the name as associated data, so a sealed value moved to another site or name does
 * not open. The key is the instance's SITE_SECRETS_KEY (32 random bytes, hex or base64), through
 * HKDF-SHA256 with a fixed label, and nothing else: rotating SESSION_SECRET or SITE_HMAC_KEY
 * leaves secrets alone. A sealed value is `<keyId>.<iv ‖ ciphertext ‖ tag, base64url>`, its key id
 * the first 8 characters of the key's SHA-256 (base64url), so a keyring of several keys can open
 * values sealed under an older one. At most SITE_SECRETS_MAX per site, SITE_SECRET_MAX_BYTES each.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import {
  isReservedSecretName,
  RESERVED_SECRET_NAMES_TEXT,
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
const KEY_BYTES = 32

/**
 * SITE_SECRETS_KEY's 32 bytes: 64 hex characters, or base64 / base64url of 32 bytes. Throws,
 * naming the variable, on anything else.
 */
export function parseSiteSecretsKey(value: string): Buffer {
  const v = value.trim()
  const bytes = /^[0-9a-fA-F]{64}$/.test(v)
    ? Buffer.from(v, 'hex')
    : /^[A-Za-z0-9+/_-]{43}={0,1}$/.test(v)
      ? Buffer.from(v.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''), 'base64url')
      : null
  if (!bytes || bytes.length !== KEY_BYTES) {
    throw new Error(
      'SITE_SECRETS_KEY must be 32 random bytes as 64 hex characters or base64 (e.g. openssl rand -hex 32)'
    )
  }
  return bytes
}

interface SealingKey {
  id: string
  key: Buffer
}

const keys = new Map<string, SealingKey>()

/** The sealing key for a SITE_SECRETS_KEY value, with its id. */
function sealingKey(raw: string): SealingKey {
  let k = keys.get(raw)
  if (!k) {
    const bytes = parseSiteSecretsKey(raw)
    k = {
      id: createHash('sha256').update(bytes).digest('base64url').slice(0, 8),
      key: Buffer.from(hkdfSync('sha256', bytes, Buffer.alloc(0), LABEL, KEY_BYTES)),
    }
    keys.set(raw, k)
  }
  return k
}

/** The keyring: the key new values are sealed with first, then any that only open old ones. */
function keyring(deps: Pick<Deps, 'config'>): SealingKey[] {
  const raw = deps.config.secrets.siteSecretsKey
  if (!raw) throw new Error('SITE_SECRETS_KEY is not set: site secrets need it')
  return [sealingKey(raw)]
}

const aad = (siteId: string, name: string) => Buffer.from(`${siteId}\n${name}`)

/** A secret's value, sealed for one site and name. */
export function sealSecret(
  deps: Pick<Deps, 'config'>,
  siteId: string,
  name: string,
  value: string
): string {
  const [current] = keyring(deps) as [SealingKey]
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', current.key, iv)
  cipher.setAAD(aad(siteId, name))
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${current.id}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`
}

/** A sealed value opened, or null when it doesn't open (no key of that id, another site or name). */
export function openSecret(
  deps: Pick<Deps, 'config'>,
  siteId: string,
  name: string,
  sealed: string
): string | null {
  const dot = sealed.indexOf('.')
  const k = keyring(deps).find(k => k.id === sealed.slice(0, dot))
  if (dot < 0 || !k) return null
  try {
    const raw = Buffer.from(sealed.slice(dot + 1), 'base64url')
    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(raw.length - TAG_BYTES)
    const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', k.key, iv)
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

/**
 * 400 `invalid_secret_name` unless `name` is one a server can read from its environment, and not
 * one a runtime sets itself (RESERVED_SECRET_NAMES, the same on every platform).
 */
export function checkSecretName(name: string) {
  if (!SITE_SECRET_NAME_RE.test(name)) {
    throw badRequest(
      `"${name}" can't be a secret's name: use A-Z, 0-9 and _, not starting with a digit, at most 64 characters`,
      'invalid_secret_name'
    )
  }
  if (isReservedSecretName(name)) {
    throw badRequest(
      `"${name}" can't be a secret's name: ${RESERVED_SECRET_NAMES_TEXT} are Fling's and the platform's. Choose another name (in fling.json too)`,
      'invalid_secret_name'
    )
  }
}

/**
 * The site's secrets by name, who set each and when; the names `declared` asks for (the live
 * version's) and those unset; and the same for the version waiting for secrets, when there is one.
 */
export async function listSecrets(
  deps: Deps,
  site: SiteRecord,
  declared: readonly string[],
  waiting?: { versionId: string; declared: readonly string[] }
): Promise<SiteSecretsResponse> {
  const records = await deps.store.listSiteSecrets(site.id)
  const names = new Set(records.map(r => r.name))
  return {
    secrets: records.map(listed),
    declared: [...declared],
    missing: declared.filter(n => !names.has(n)),
    ...(waiting
      ? {
          waiting: {
            versionId: waiting.versionId,
            declared: [...waiting.declared],
            missing: waiting.declared.filter(n => !names.has(n)),
          },
        }
      : {}),
  }
}

/**
 * Set a secret: 400 `invalid_secret_name`, 400 `invalid_secret_value` for an empty one (one
 * platform's environment can't hold it; a server that wants a default omits the secret), 413 `too_large` over SITE_SECRET_MAX_BYTES, 409
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
  if (value === '') {
    throw new ApiError(
      400,
      'invalid_secret_value',
      `A secret's value can't be empty: give ${name} a value, or remove it`
    )
  }
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
