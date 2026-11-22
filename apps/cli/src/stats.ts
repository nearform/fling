/**
 * A site's metrics from the CLI and the local MCP (the `metrics` capability): `fling stats` and
 * `fling_stats`. Counts only (views and pushes per day, week and month, last viewed, last pushed),
 * read from `GET /api/sites/:name/metrics`, which answers a site's owners, publishers and admins
 * and 404s for anyone else, as for a missing site.
 */
import type { InstanceMetadata } from '@fling/shared'
import { type SiteMetrics, SiteMetricsSchema } from '@fling/shared/metrics'
import { type ApiClient, CliApiError } from './api.ts'
import { CliError } from './errors.ts'

/**
 * Whether the instance has site metrics, by its metadata: its `metrics` capability. Off unless it
 * says so (an instance from before metrics has none). No instance: not known (undefined).
 */
export function metricsEnabled(
  instance: Pick<InstanceMetadata, 'capabilities'> | null | undefined
): boolean | undefined {
  if (!instance) return undefined
  return instance.capabilities.metrics === true
}

/** The site's metrics; a 404 says who may read them. */
export async function getSiteMetrics(
  client: ApiClient,
  name: string,
  instanceName = 'this Fling'
): Promise<SiteMetrics> {
  try {
    return await client.request('GET', `/api/sites/${encodeURIComponent(name)}/metrics`, {
      schema: SiteMetricsSchema,
    })
  } catch (error) {
    if (error instanceof CliApiError && error.status === 404) {
      throw new CliError(`No site "${name}" whose metrics you can read on ${instanceName}`, {
        hint: "Check the name (`fling ls`). A site's metrics are for its owners and publishers.",
      })
    }
    throw error
  }
}

const BARS = '▁▂▃▄▅▆▇█'

/** One character per count, its height relative to the largest: `▁▁▃█▂`. */
export function sparkline(counts: readonly number[]): string {
  const max = Math.max(0, ...counts)
  return counts
    .map(n => (max === 0 ? BARS[0] : BARS[Math.round((n / max) * (BARS.length - 1))]))
    .join('')
}
