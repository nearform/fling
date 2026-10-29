/**
 * Sign-in links: how someone invited from outside the email policy signs in when they can't at
 * the instance's issuer. A link is 32 random bytes; only their sha256 is stored
 * (`MAGIC#<hash>/MAGIC`, with the email and where to go afterwards), and the token itself is never
 * logged. Taking one is a conditional delete, so it works once.
 *
 * - `requestSignInLink`: the login page's "Email me a sign-in link" (POST /auth/link). It mails a
 *   15-minute link only to an address whose standing comes from a live invitation, at most
 *   SIGN_IN_LINKS_PER_HOUR an hour per address and SIGN_IN_LINKS_PER_MINUTE a minute for the
 *   instance; the route answers the same whatever happened, so it never says who is invited.
 * - `mintSignInLink`: a link for any address and lifetime, also for the invitation and share
 *   emails (7 days, INVITATION_LINK_TTL_SECONDS).
 * - `peekSignInLink` (GET /auth/link) reads a link without taking it: mail scanners open every
 *   link, so only the confirm page's button, a form POST, takes it (`takeSignInLink`).
 */
import { createHash, randomBytes } from 'node:crypto'
import { SIGN_IN_LINK_MINUTES } from '@fling/shared'
import type { Config } from '../config.ts'
import { sendDirectMail } from '../notifications/direct-mail.ts'
import { addressHash, logNotify } from '../notifications/log.ts'
import { signInLinkSection } from '../notifications/templates/sign-in-link.ts'
import { hourOf, minuteOf, type SignInLinkRecord } from '../store/types.ts'
import type { Deps } from '../types.ts'
import { safeReturnUrl } from './return-url.ts'
import { admittedByConfig, type Standing, standingOf } from './standing.ts'

/** A link asked for on the login page. */
export const SIGN_IN_LINK_TTL_SECONDS = SIGN_IN_LINK_MINUTES * 60
/** A link that comes with an invitation or a first share email. */
export const INVITATION_LINK_TTL_SECONDS = 7 * 24 * 60 * 60
/** Links one address may ask for in an hour. */
export const SIGN_IN_LINKS_PER_HOUR = 5
/** Links the instance sends on request in a minute, whoever asks. */
export const SIGN_IN_LINKS_PER_MINUTE = 30

/** The path in the email: GET it to land on the confirm page. */
export const SIGN_IN_LINK_PATH = '/auth/link'

/** What a link's error is called on the login page (`/login?error=`). */
export type SignInLinkError = 'link_expired' | 'link_used' | 'not_invited'

/** The stored form of a token: its sha256, hex. */
export const signInLinkHash = (token: string) => createHash('sha256').update(token).digest('hex')

/** A token as minted: 32 random bytes, base64url (43 characters). */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

export const isSignInLinkToken = (value: string | undefined | null): value is string =>
  typeof value === 'string' && TOKEN_RE.test(value)

/** The URL a token is emailed as. */
export const signInLinkUrl = (config: Pick<Config, 'appOrigin'>, token: string) =>
  `${config.appOrigin}${SIGN_IN_LINK_PATH}?t=${token}`

export interface MintedSignInLink {
  /** what goes in the email: `${appOrigin}/auth/link?t=<token>` */
  url: string
  /** the token itself, for the URL only: never log or store it */
  token: string
  hash: string
  expiresAt: string
}

/**
 * Store a new sign-in link for `email` that lasts `ttlSeconds` and goes to `ret` once used (checked
 * here like `/auth/login`'s `return`: an app path or a site URL, else the app's home).
 */
export async function mintSignInLink(
  deps: Pick<Deps, 'config' | 'store' | 'clock'>,
  input: { email: string; return?: string | null; ttlSeconds: number }
): Promise<MintedSignInLink> {
  const token = randomBytes(32).toString('base64url')
  const hash = signInLinkHash(token)
  const now = deps.clock.now()
  const link: SignInLinkRecord = {
    hash,
    email: input.email,
    return: safeReturnUrl(input.return, deps.config),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
  }
  await deps.store.putSignInLink(link)
  return { url: signInLinkUrl(deps.config, token), token, hash, expiresAt: link.expiresAt }
}

/** What happened to a request for a link: for the log line only, never the response. */
export type SignInLinkOutcome = 'sent' | 'not_sent' | 'policy' | 'not_invited' | 'limited'

/**
 * The login page's "Email me a sign-in link": send a 15-minute link to `email` when an invitation
 * gives it standing. People the email policy admits sign in at the issuer, so they get none.
 */
export async function requestSignInLink(
  deps: Deps,
  email: string,
  ret: string | undefined
): Promise<SignInLinkOutcome> {
  const outcome = await decideAndSend(deps, email, ret)
  logNotify('info', 'sign-in link requested', { to: addressHash(email), outcome })
  return outcome
}

async function decideAndSend(
  deps: Deps,
  email: string,
  ret: string | undefined
): Promise<SignInLinkOutcome> {
  if (admittedByConfig(deps.config, email)) return 'policy'
  if ((await standingOf(deps, email)) === 'none') return 'not_invited'
  const now = deps.clock.now()
  if ((await deps.store.countSignInLinkRequest(email, hourOf(now))) > SIGN_IN_LINKS_PER_HOUR) {
    return 'limited'
  }
  if ((await deps.store.countSignInLinkInstance(minuteOf(now))) > SIGN_IN_LINKS_PER_MINUTE) {
    return 'limited'
  }
  const link = await mintSignInLink(deps, {
    email,
    return: ret ?? null,
    ttlSeconds: SIGN_IN_LINK_TTL_SECONDS,
  })
  const { result } = await sendDirectMail(deps, {
    to: email,
    tag: 'auth.link',
    section: signInLinkSection({
      instance: deps.config.instanceName,
      to: email,
      url: link.url,
      ttlSeconds: SIGN_IN_LINK_TTL_SECONDS,
    }),
  })
  return result.ok ? 'sent' : 'not_sent'
}

/** Why a link can't be used: taken already (until it would have expired), else expired. */
async function deadLink(deps: Pick<Deps, 'store'>, hash: string): Promise<SignInLinkError> {
  return (await deps.store.signInLinkUsed(hash)) ? 'link_used' : 'link_expired'
}

/**
 * A link, left in place, and the standing of its address now: for the confirm page, which names
 * the address before anything is taken.
 */
export async function peekSignInLink(
  deps: Pick<Deps, 'config' | 'store'>,
  token: string | undefined
): Promise<{ ok: true; email: string } | { ok: false; error: SignInLinkError }> {
  if (!isSignInLinkToken(token)) return { ok: false, error: 'link_expired' }
  const hash = signInLinkHash(token)
  const link = await deps.store.getSignInLink(hash)
  if (!link) return { ok: false, error: await deadLink(deps, hash) }
  if ((await standingOf(deps, link.email)) === 'none') return { ok: false, error: 'not_invited' }
  return { ok: true, email: link.email }
}

/**
 * Take a link: once, and only while its address still has standing (an invitation revoked since
 * it was sent signs no one in). The link is spent either way.
 */
export async function takeSignInLink(
  deps: Pick<Deps, 'config' | 'store'>,
  token: string | undefined
): Promise<
  | { ok: true; email: string; return: string; standing: Exclude<Standing, 'none'> }
  | { ok: false; error: SignInLinkError }
> {
  if (!isSignInLinkToken(token)) return { ok: false, error: 'link_expired' }
  const hash = signInLinkHash(token)
  const link = await deps.store.consumeSignInLink(hash)
  if (!link) return { ok: false, error: await deadLink(deps, hash) }
  const standing = await standingOf(deps, link.email)
  if (standing === 'none') return { ok: false, error: 'not_invited' }
  return { ok: true, email: link.email, return: link.return, standing }
}
