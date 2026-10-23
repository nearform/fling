import { randomBytes } from 'node:crypto'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Unbiased random string over `alphabet` (rejection sampling). */
export function randomString(length: number, alphabet: string): string {
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit) out += alphabet[byte % alphabet.length]
      if (out.length === length) break
    }
  }
  return out
}

/** 12-char lowercase base32 id (60 bits) — siteIds and API key ids. */
export const newId = () => randomString(12, BASE32)

/** Share tokens: 20 chars of [a-z0-9] (SHARE_TOKEN_LENGTH). */
export const newShareToken = () => randomString(20, ALNUM)
