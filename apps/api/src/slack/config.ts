/**
 * Whether the instance has a Slack app: both its secrets set (the `slackUnfurls` capability). The
 * placeholder `unset`, which the Terraform modules write into a secret someone fills by hand,
 * counts as not set, so the app stays off until both are filled.
 */
import type { Config } from '../config.ts'

const isSet = (value: string | undefined) => Boolean(value && value.trim() !== 'unset')

/** Where the Slack routes are mounted: the app's request URL is this plus `/events`. */
export const SLACK_BASE = '/api/integrations/slack'

export const slackOn = (config: Pick<Config, 'secrets'>): boolean =>
  isSet(config.secrets.slackSigningSecret) && isSet(config.secrets.slackBotToken)
