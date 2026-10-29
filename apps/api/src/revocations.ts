/**
 * The revocation list: how revoking someone reaches the edge. Standing is rechecked on every API
 * request, but the edge opens members-level sites with any member's `fling_site`, which lasts 7
 * days and holds no standing. So revoking writes `revoked:<mac>` → the expiry a cookie issued at
 * that moment would have, to the route table (route-keys.ts), and the edge sends a member's cookie
 * expiring no later than it (one issued by the revocation's second) to sign in, where the app refuses someone without standing and gives anyone else a fresh cookie
 * (site-routing.ts). Re-inviting needs no change here: the new sign-in's cookie is newer.
 *
 * A revocation stays on the list for REVOCATION_KEEP_SECONDS, well past the last cookie it could
 * stop. Each one is kept as a record due then (`REVOKED`, store/records.ts), and the sweep, run
 * by each platform's one-minute tick, takes due ones off the list. The record is written before the
 * list key, so no key outlives its record. A later revocation of the same address replaces the
 * list's value; the earlier record, when due, sees a value that isn't its own and leaves it.
 */
import { revokedKvsKey } from '@fling/shared'
import { revocationMac, SITE_COOKIE_TTL_SECONDS } from '@fling/shared/site-cookie'
import type { Deps } from './types.ts'

/** How long a revocation stays on the list: well past the last cookie it could stop (7 days). */
export const REVOCATION_KEEP_SECONDS = 30 * 24 * 60 * 60

/** Revocations taken off the list per sweep: more wait for the next tick. */
const SWEEP_LIMIT = 100

/** Put `email` on the revocation list as of `at`: their member cookies stop opening sites. */
export async function revokeSiteCookies(deps: Deps, email: string, at: Date): Promise<void> {
  const mac = revocationMac(email, deps.config.secrets.siteHmacKey)
  const before = Math.floor(at.getTime() / 1000) + SITE_COOKIE_TTL_SECONDS
  const dueAt = new Date(at.getTime() + REVOCATION_KEEP_SECONDS * 1000).toISOString()
  await deps.store.putRevocation({ mac, before, dueAt })
  await deps.routeTable.put(revokedKvsKey(mac), String(before))
}

/** Take the revocations that are due off the list; returns how many were. */
export async function sweepRevocations(deps: Deps): Promise<number> {
  const due = await deps.store.dueRevocations(deps.clock.now().toISOString(), SWEEP_LIMIT)
  for (const r of due) {
    const listKey = revokedKvsKey(r.mac)
    if ((await deps.routeTable.get(listKey)) === String(r.before)) {
      await deps.routeTable.delete(listKey)
    }
    await deps.store.deleteRevocation(r)
  }
  return due.length
}
