/**
 * The Azure platform's own settings, beside the core's config (@fling/api/config): where its
 * services are. Terraform sets them on the Container App and its jobs (infra/api.tf); none is a
 * secret, since every service is reached with the host's managed identity (AZURE_CLIENT_ID, read
 * by DefaultAzureCredential).
 *
 * - COSMOS_ENDPOINT, COSMOS_DATABASE (default `fling`), COSMOS_CONTAINER (default `items`): the
 *   Table (src/table/cosmos.ts).
 * - BLOB_ENDPOINT (`https://<account>.blob.core.windows.net/`), SITES_CONTAINER (default
 *   `sites`): the Blobs (src/blobs/blob.ts).
 * - WEB_PUBSUB_ENDPOINT, WEB_PUBSUB_HUB (default `fling`): the live hub (src/live.ts), with
 *   LIVE_URL (the core's) and the LIVE_EVENTS_SECRET secret.
 * - ACS_ENDPOINT: the mailer (src/mail/acs.ts), with MAIL_DRIVER=acs.
 */
type Env = Record<string, string | undefined>

export interface AzureSettings {
  cosmos: { endpoint: string; database: string; container: string }
  blobs: { endpoint: string; container: string }
  /** with live rooms */
  webPubSub?: { endpoint: string; hub: string; eventsSecret: string }
  /** with MAIL_DRIVER=acs */
  acsEndpoint?: string
}

const value = (env: Env, name: string) => env[name]?.trim() || undefined

function required(env: Env, name: string): string {
  const v = value(env, name)
  if (!v) throw new Error(`${name} is required on Azure (infra/api.tf sets it)`)
  return v
}

function httpsUrl(env: Env, name: string): string {
  const v = required(env, name)
  if (!/^https?:\/\//.test(v)) throw new Error(`${name} must be an https:// URL`)
  return v
}

/** The settings, checked: `live` and `mail` say which of the optional services the config uses. */
export function azureSettings(env: Env, use: { live: boolean; mail: boolean }): AzureSettings {
  const settings: AzureSettings = {
    cosmos: {
      endpoint: httpsUrl(env, 'COSMOS_ENDPOINT'),
      database: value(env, 'COSMOS_DATABASE') ?? 'fling',
      container: value(env, 'COSMOS_CONTAINER') ?? 'items',
    },
    blobs: {
      endpoint: httpsUrl(env, 'BLOB_ENDPOINT'),
      container: value(env, 'SITES_CONTAINER') ?? 'sites',
    },
  }
  if (use.live) {
    const eventsSecret = required(env, 'LIVE_EVENTS_SECRET')
    if (eventsSecret.length < 32)
      throw new Error('LIVE_EVENTS_SECRET must be at least 32 characters')
    settings.webPubSub = {
      endpoint: httpsUrl(env, 'WEB_PUBSUB_ENDPOINT'),
      hub: value(env, 'WEB_PUBSUB_HUB') ?? 'fling',
      eventsSecret,
    }
  }
  if (use.mail) settings.acsEndpoint = httpsUrl(env, 'ACS_ENDPOINT')
  return settings
}
