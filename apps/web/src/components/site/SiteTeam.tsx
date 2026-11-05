/**
 * Who holds the site (the `siteRoles` capability): its owners, who all have every right over it,
 * and its publishers, who publish and roll back but change nothing else. Each list is people and
 * groups (`PeoplePicker`), saved whole on every change, as the Access section's list is. Owners
 * and admins change them; a publisher sees them read-only. A site keeps at least one person as an
 * owner (`last_owner`), and only members of the instance hold a role (`email_not_allowed`), never a
 * guest; naming a group trusts whoever manages it, so the section says so. Taking yourself out of
 * the owners asks first, since the site may then leave your list.
 */
import type { SiteDetail, SiteRoleMembers } from '@fling/shared'
import { useNavigate } from 'react-router-dom'
import { useInstance } from '../../hooks/instance'
import { useSiteActions } from '../../hooks/queries'
import { DEFAULT_INSTANCE_NAME } from '../../lib/instance'
import { RoleLists } from './RoleLists'
import { SiteSection } from './SiteSection'

export function SiteTeam({ site }: { site: SiteDetail }) {
  const instance = useInstance()
  const instanceName = instance?.name ?? DEFAULT_INSTANCE_NAME
  const actions = useSiteActions(site.name)
  const navigate = useNavigate()
  if (!site.owners) return null
  const publishers: SiteRoleMembers = site.publishers ?? { emails: [], groups: [] }
  const editable = site.role === 'owner' || site.role === 'admin'

  return (
    <SiteSection
      title="Owners and publishers"
      description={
        editable
          ? `Only people who can sign in to ${instanceName} may own or publish this site.`
          : 'You publish this site. Its owners decide who owns and publishes it.'
      }
    >
      <RoleLists
        owners={site.owners}
        publishers={publishers}
        editable={editable}
        busy={actions.setRoles.isPending}
        save={change => actions.setRoles.mutateAsync(change)}
        copy={{
          owners: {
            description:
              'Publish, change who can open it and its settings, its owners and publishers, and delete it.',
            hint: 'A site always keeps at least one person as an owner.',
          },
          publishers: {
            description: 'Publish new versions and roll back, but change nothing else.',
            hint: 'Someone who is also an owner stays an owner.',
          },
        }}
        groupWarning="Naming a group trusts whoever manages it: anyone they add to the group owns or publishes this site too."
        leave={{
          title: 'Stop owning this site?',
          message:
            'You will no longer be able to change it, and it leaves your sites unless you publish it or are in one of its groups.',
          after: () => navigate('/'),
        }}
      />
    </SiteSection>
  )
}
