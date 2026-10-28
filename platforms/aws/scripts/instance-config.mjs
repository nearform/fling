// The instance values a deploy ships in lambda.zip as instance.json (FLING_INSTANCE_CONFIG, from
// AWS_DEPLOY_CONFIG's `INSTANCE`): a flat JSON object of ENV_STYLE keys. MAIL_* and SES_* are
// refused, as Cloudflare's deploy config refuses them in its INSTANCE: email is set only by the
// Terraform module's `mail` variable, which also grants the function its SES permission and adds
// the drain schedule.

/** The parsed instance values; throws on anything else. */
export function parseInstanceConfig(text) {
  const parsed = JSON.parse(text)
  const ok =
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.entries(parsed).every(
      ([k, v]) => /^[A-Z][A-Z0-9_]*$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)
    )
  if (!ok) throw new Error('FLING_INSTANCE_CONFIG must be a flat JSON object of ENV_STYLE keys')
  const mailKey = Object.keys(parsed).find(k => /^(MAIL|SES)_/.test(k))
  if (mailKey) {
    throw new Error(
      `FLING_INSTANCE_CONFIG.${mailKey} is not allowed: email is set in the Terraform module's mail variable`
    )
  }
  return parsed
}
