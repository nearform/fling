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
 * by maintenance (maintenance.ts, every platform's hourly tick, which every instance has with or
 * without mail), takes due ones off the list. An entry kept up to an hour past its due time stops
 * nothing more: the last cookie it could stop expired 23 days before. The record is written before the
 * list key, so no key outlives its record. A later revocation of the same address replaces the
 * list's value; the earlier record, when due, sees a value that isn't its own and leaves it.
 */
import { revokedKvsKey } from '@fling/shared'
import { revocationMac, SITE_COOKIE_TTL_SECONDS } from '@fling/shared/site-cookie'
import type { Deps } from './types.ts'

/** How long a revocation stays on the list: well past the last cookie it could stop (7 days). */
export const REVOCATION_KEEP_SECONDS = 30 * 24 * 60 * 60

/** Revocations read per page of the sweep. */
const SWEEP_PAGE = 100

/** Put `email` on the revocation list as of `at`: their member cookies stop opening sites. */
export async function revokeSiteCookies(deps: Deps, email: string, at: Date): Promise<void> {
  const mac = revocationMac(email, deps.config.secrets.siteHmacKey)
  const before = Math.floor(at.getTime() / 1000) + SITE_COOKIE_TTL_SECONDS
  const dueAt = new Date(at.getTime() + REVOCATION_KEEP_SECONDS * 1000).toISOString()
  await deps.store.putRevocation({ mac, before, dueAt })
  await deps.routeTable.put(revokedKvsKey(mac), String(before))
}

/**
 * Take the revocations that are due off the list, a page at a time until none are due or the
 * deadline passes (the rest wait for the next run); returns how many were.
 */
export async function sweepRevocations(
  deps: Deps,
  opts: { deadline?: number } = {}
): Promise<number> {
  let swept = 0
  for (;;) {
    const due = await deps.store.dueRevocations(deps.clock.now().toISOString(), SWEEP_PAGE)
    for (const r of due) {
      const listKey = revokedKvsKey(r.mac)
      if ((await deps.routeTable.get(listKey)) === String(r.before)) {
        await deps.routeTable.delete(listKey)
      }
      await deps.store.deleteRevocation(r)
    }
    swept += due.length
    if (due.length < SWEEP_PAGE) return swept
    if (opts.deadline !== undefined && Date.now() > opts.deadline) return swept
  }
}
