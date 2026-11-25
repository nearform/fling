/**
 * The archive policy from the CLI and the local MCP (archive-policy.ts in `@fling/shared`): the
 * keep flag (`fling keep`, `fling_keep`) and the policy's status for admins (`fling admin
 * archive-policy`, `fling_admin_archive_policy`).
 *
 * Keeping is the site's owners' (`PUT /api/sites/:name/keep`, only where the instance advertises
 * `archivePolicy`); an admin keeps someone else's site from their browser session only, so through
 * an API key the server answers 404 as for a missing site. `setKeep` asks the site again then, to
 * say which it was. The status (`GET /api/admin/archive-policy`) answers any admin credential and
 * refuses everyone else; turning the policy live or back to dry run is an admin's, from their
 * browser session at Admin → Archive policy: neither the CLI nor the MCP does it, they print the link.
 */
import {
  type ArchivePolicyStatus,
  ArchivePolicyStatusSchema,
  archivePolicyOf,
  type InstanceMetadata,
  type Site,
  SiteSchema,
  whoHolds,
} from '@fling/shared'
import { type ApiClient, CliApiError } from './api.ts'
import { CliError, EXIT_FORBIDDEN } from './errors.ts'
import { getSite } from './sites.ts'

/** The message for a Fling without the policy: nothing archives its sites, so nothing to keep. */
export const noArchivePolicy = (instance: Pick<InstanceMetadata, 'name'> | null, where = '') =>
  `${instance?.name ?? 'This Fling'}${where} has no archive policy: it never archives sites for disuse, so there is nothing to keep them from`

/** Refuse when the instance is known to have no archive policy (an unknown one: the server says). */
export function requireArchivePolicy(instance: InstanceMetadata | null, where = ''): void {
  if (instance && !archivePolicyOf(instance)) throw new CliError(noArchivePolicy(instance, where))
}

/**
 * Keep the site from the archive policy, or stop keeping it. A refusal names who may: the 404 an
 * owner-only change gives a publisher, or an admin through an API key, is told apart from a
 * missing site by reading the site, which both can.
 */
export async function setKeep(
  client: ApiClient,
  name: string,
  keep: boolean,
  opts: { appOrigin?: string } = {}
): Promise<Site> {
  try {
    return await client.request('PUT', `/api/sites/${encodeURIComponent(name)}/keep`, {
      schema: SiteSchema,
      body: { keep },
    })
  } catch (error) {
    if (!(error instanceof CliApiError) || error.status !== 404) throw error
    const site = await getSite(client, name).catch(() => null)
    // An owner's 404 is the server's own (no archive policy there): say that as it is.
    if (site?.role !== 'admin' && site?.role !== 'publisher') throw error
    const page = opts.appOrigin
      ? ` (${opts.appOrigin.replace(/\/+$/, '')}/sites/${encodeURIComponent(name)})`
      : ''
    throw new CliError(
      site.role === 'admin'
        ? `As an admin you can keep ${name} only from your browser session: open its page in the web app${page}`
        : `Only the owners of ${name} can keep it`,
      {
        exitCode: EXIT_FORBIDDEN,
        hint:
          site.role === 'admin'
            ? undefined
            : `Ask one of them${site.owners ? ` (${whoHolds(site.owners)})` : ''}, or an admin.`,
        cause: error,
      }
    )
  }
}

/** The archive policy's status, for admins; anyone else is told it is theirs. */
export async function getArchivePolicy(
  client: ApiClient,
  opts: { instanceName?: string } = {}
): Promise<ArchivePolicyStatus> {
  try {
    return await client.request('GET', '/api/admin/archive-policy', {
      schema: ArchivePolicyStatusSchema,
    })
  } catch (error) {
    if (error instanceof CliApiError && (error.status === 403 || error.status === 404)) {
      throw new CliApiError({
        status: 403,
        code: 'forbidden',
        message: `Only an admin of ${opts.instanceName ?? 'this Fling'} can see its archive policy`,
        hint: 'Sign in as an admin (`fling whoami` says who you are).',
        cause: error,
      })
    }
    throw error
  }
}
