/** What the admin parts of the UI show, as plain functions of the signed-in user (tested). */
import {
  type AdminSettings,
  type AdminUser,
  guideUrl,
  type Me,
  SETTING_GROUPS,
  type SettingGroup,
  type SettingValue,
} from '@fling/shared'

const AWS_GUIDE = 'platforms/aws/DEPLOY.md'
const CLOUDFLARE_GUIDE = 'platforms/cloudflare/DEPLOY.md'

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

/** Admin → Settings. */
export const ADMIN_SETTINGS_PATH = '/admin/settings'

/** Each settings group's heading, and where the deploy guides explain its keys. */
export const SETTING_GROUP_INFO: Record<
  SettingGroup,
  { title: string; aws: string; cloudflare: string }
> = {
  sign_in: {
    title: 'Sign-in',
    aws: guideUrl(AWS_GUIDE, 'sign-in-openid-connect'),
    cloudflare: guideUrl(CLOUDFLARE_GUIDE, 'sign-in-openid-connect'),
  },
  sites: {
    title: 'Sites',
    aws: guideUrl(AWS_GUIDE, 'instance-configuration'),
    cloudflare: guideUrl(CLOUDFLARE_GUIDE, 'the-deploy-config-cf_deploy_config'),
  },
  branding: {
    title: 'Branding',
    aws: guideUrl(AWS_GUIDE, 'instance-configuration'),
    cloudflare: guideUrl(CLOUDFLARE_GUIDE, 'the-deploy-config-cf_deploy_config'),
  },
  features: {
    title: 'Features',
    aws: guideUrl(AWS_GUIDE, 'instance-configuration'),
    cloudflare: guideUrl(CLOUDFLARE_GUIDE, 'the-deploy-config-cf_deploy_config'),
  },
  mail: {
    title: 'Mail',
    aws: guideUrl(AWS_GUIDE, 'email'),
    cloudflare: guideUrl(CLOUDFLARE_GUIDE, 'email'),
  },
  platform: {
    title: 'Platform',
    aws: guideUrl(AWS_GUIDE, 'infrastructure-the-terraform-module'),
    cloudflare: guideUrl(CLOUDFLARE_GUIDE, 'the-deploy-config-cf_deploy_config'),
  },
}

/** The settings and secrets of each group, in the groups' order; groups with neither are left out. */
export function settingGroups(data: AdminSettings) {
  return SETTING_GROUPS.map(group => ({
    group,
    ...SETTING_GROUP_INFO[group],
    settings: data.settings.filter(s => s.group === group),
    secrets: data.secrets.filter(s => s.group === group),
  })).filter(g => g.settings.length + g.secrets.length > 0)
}

/** A setting's value as text: null → null (the page says "Not set"). */
export function settingText(value: SettingValue): string | null {
  if (value === null) return null
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (Array.isArray(value)) return value.length ? value.join(', ') : null
  return String(value)
}
