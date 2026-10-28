/** What the admin parts of the UI show, as plain functions of the signed-in user (tested). */
import type { AdminUser, Me } from '@fling/shared'

/** The banner while an admin impersonates someone; null otherwise. */
export function impersonationNotice(me: Me | null | undefined): string | null {
  return me?.impersonator ? `Viewing as ${me.email}` : null
}

/** Whether the side nav offers Admin: admins, in their own session. */
export const showsAdmin = (me: Me | null | undefined) => me?.admin === true && !me.impersonator

/** Why a row has no Impersonate button (the API refuses these too); null: it has one. */
export function impersonateBlocked(me: Me, user: AdminUser): string | null {
  if (user.email === me.email) return 'You'
  if (user.admin) return 'Admin'
  return null
}

/** Where the Admin item and the end of an impersonation lead. */
export const ADMIN_USERS_PATH = '/admin/users'
