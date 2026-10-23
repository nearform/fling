/** API keys: `fling_<43 base64url chars>`, stored only as a SHA-256 hex hash (rocketpod pattern). */
import { createHash, randomBytes } from 'node:crypto'
import { newId } from '../lib/ids.ts'
import type { ApiKeyRecord, Store, User } from '../store/types.ts'

export const API_KEY_PREFIX = 'fling_'
/** `lastUsedAt` is stamped at most this often */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000

export const hashApiKey = (plaintext: string) =>
  createHash('sha256').update(plaintext).digest('hex')

export function generateApiKey(): { plaintext: string; hash: string } {
  const plaintext = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
  return { plaintext, hash: hashApiKey(plaintext) }
}

/** The ONE way a key comes into existence. */
export async function mintApiKey(store: Store, email: string, name: string, now: Date) {
  const { plaintext, hash } = generateApiKey()
  const record: ApiKeyRecord = {
    id: newId(),
    email,
    name,
    hash,
    createdAt: now.toISOString(),
    lastUsedAt: null,
  }
  await store.createApiKey(record)
  return { record, plaintext }
}

export async function validateApiKey(
  store: Store,
  plaintext: string,
  now: Date
): Promise<{ key: ApiKeyRecord; user: User } | null> {
  if (!plaintext.startsWith(API_KEY_PREFIX) || plaintext.length > 256) return null
  const key = await store.findApiKeyByHash(hashApiKey(plaintext))
  if (!key) return null
  const user = await store.getUser(key.email)
  if (!user) return null
  if (!key.lastUsedAt || now.getTime() - Date.parse(key.lastUsedAt) > TOUCH_INTERVAL_MS) {
    await store.touchApiKey(key.email, key.id, now.toISOString())
  }
  return { key, user }
}
