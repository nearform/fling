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

/** base32hex: its digits sort in byte order the way their values do. */
const SORTABLE = '0123456789abcdefghijklmnopqrstuv'

/**
 * 18 chars: the time in ms (10 base32hex digits, good until the year 37000) then 8 random ones
 * (40 bits). Ids made later sort later (byte order); ones made in the same millisecond, randomly.
 */
export function newCommentId(now: Date): string {
  let t = now.getTime()
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = SORTABLE[t % 32] + time
    t = Math.floor(t / 32)
  }
  return time + randomString(8, SORTABLE)
}
