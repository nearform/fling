/**
 * Who holds a Path, besides the site's owners, who own every Path: its own owners (publish to it,
 * roll it back, change its owners and publishers, archive and delete it) and its publishers
 * (publish and roll back). Shown to those on the site; owners of the Path or the site change
 * them (`editable`), anyone else sees them read-only. A Path owner taking themselves out is
 * asked first; a site owner stays an owner of the Path whatever its list says.
 */
import type { SitePath, SiteRoleMembers } from '@fling/shared'
import { usePathActions } from '../../hooks/queries'
import { shownFolder } from '../../lib/paths'
import { RoleLists } from './RoleLists'
import { SiteSection } from './SiteSection'

const nobody: SiteRoleMembers = { emails: [], groups: [] }

export function PathTeam({
  name,
  path,
  editable,
  siteOwner,
}: {
  name: string
  path: SitePath
  editable: boolean
  /** the reader owns the site, so removing themselves from the Path's owners changes nothing */
  siteOwner: boolean
}) {
  const actions = usePathActions(name, path.folder)
  if (!path.owners) return null
  const folder = shownFolder(path.folder)

  return (
    <SiteSection
      title="Owners and publishers"
      description={
        editable
          ? `The site’s owners own ${folder} too. Add people who look after this Path alone.`
          : `The site’s owners and the Path’s owners decide who owns and publishes ${folder}.`
      }
    >
      <RoleLists
        owners={path.owners}
        publishers={path.publishers ?? nobody}
        editable={editable}
        busy={actions.setRoles.isPending}
        save={change => actions.setRoles.mutateAsync(change)}
        copy={{
          owners: {
            description: `Publish to ${folder}, roll it back, change its owners and publishers, archive and delete it.`,
            hint: 'The site’s owners are always owners of its Paths.',
          },
          publishers: {
            description: `Publish new versions of ${folder} and roll it back, but change nothing else.`,
            hint: 'Someone who is also an owner stays an owner.',
          },
        }}
        groupWarning={`Naming a group trusts whoever manages it: anyone they add to the group owns or publishes ${folder} too.`}
        {...(!siteOwner && {
          leave: {
            title: `Stop owning ${folder}?`,
            message: `You will no longer be able to change ${folder} unless you are in one of its owners’ groups.`,
            after: () => {},
          },
        })}
      />
    </SiteSection>
  )
}
