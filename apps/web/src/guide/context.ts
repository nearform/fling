/**
 * What the Guide's placeholders become on this instance, for this reader: its address, name and
 * install command from the instance metadata, the facts from the code, and which capabilities and
 * admin pages the reader gets. Until the metadata arrives, this page's own origin stands in.
 */
import {
  DEFAULT_INSTALL_COMMAND,
  GUIDE_FACTS,
  type GuideContext,
  type InstanceMetadata,
  instanceSiteUrl,
  type Me,
} from '@fling/shared'
import { showsAdmin } from '../lib/admin'
import { audienceFor, DEFAULT_INSTANCE_NAME } from '../lib/instance'

export function guideContextFor(
  instance: InstanceMetadata | null,
  me: Me | null | undefined,
  origin: string
): GuideContext {
  const appOrigin = instance?.appOrigin ?? origin
  return {
    instance: {
      origin: appOrigin,
      name: instance?.name ?? DEFAULT_INSTANCE_NAME,
      mcp: `${appOrigin}/mcp`,
      install: instance?.installCommand ?? DEFAULT_INSTALL_COMMAND,
      sites: instance?.sitesDomain ?? '<sites domain>',
      account: instance ? `your ${instance.auth.displayName} account` : 'your account',
      audience: audienceFor(instance),
    },
    siteUrl: name =>
      instance
        ? instanceSiteUrl(instance, name).replace(/\/$/, '')
        : `https://${name}.<sites domain>`,
    facts: GUIDE_FACTS,
    reader: { capabilities: instance?.capabilities ?? {}, admin: showsAdmin(me) },
  }
}
