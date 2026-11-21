# Email (var.mail): the notifications' email channel on Azure Communication Services Email, from a
# domain of the operator's. Nothing here exists without var.mail.
#
# - An Email Communication Service with one customer-managed domain (default mail.<sites domain>;
#   `mail` is a reserved site name, so it never shadows a site), its sender username (MAIL_FROM is
#   <username>@<domain>, with the display name mail.from_name: Communication Services takes the
#   name from the sender username, never from the message) and a Communication Service linked to
#   it, which the app sends through with its managed identity (iam.tf; platforms/azure/src/mail/acs.ts).
# - The domain's verification, SPF and DKIM records go in var.dns_zone when it is given (the domain
#   must be in it), otherwise they are in the dns_records output. Verifying the domain is a step in
#   the portal or the CLI once they resolve (DEPLOY.md, Email); until then sends are refused.
# - MAIL_* and ACS_ENDPOINT reach the app's environment (api.tf), and the minute's notify job
#   exists (api.tf); var.environment and var.instance may not set them.

locals {
  mail = var.mail == null ? null : merge(var.mail, {
    domain    = lower(coalesce(var.mail.domain, "mail.${local.sites_domain}"))
    from_name = coalesce(var.mail.from_name, var.name)
  })

  mail_from = local.mail == null ? null : "${local.mail.username}@${local.mail.domain}"

  mail_environment = local.mail == null ? {} : {
    for k, v in {
      MAIL_DRIVER   = "acs"
      MAIL_FROM     = local.mail_from
      MAIL_REPLY_TO = local.mail.reply_to
      ACS_ENDPOINT  = "https://${azurerm_communication_service.this[0].hostname}"
    } : k => v if v != null
  }

  # The verification records, and each one's FQDN: Communication Services names them relative to
  # the domain ("@" for the domain itself), and a name that is already a FQDN is taken as it is.
  mail_records = local.mail == null ? null : azurerm_email_communication_service_domain.this[0].verification_records[0]
  mail_fqdn = local.mail == null ? {} : {
    for kind in ["domain", "spf", "dkim", "dkim2"] : kind => (
      contains(["@", ""], local.mail_records[kind][0].name) ? local.mail.domain :
      endswith(local.mail_records[kind][0].name, local.mail.domain) ? local.mail_records[kind][0].name :
      "${local.mail_records[kind][0].name}.${local.mail.domain}"
    )
  }
  mail_dns_on = local.mail != null && var.dns_zone != null
  # Those FQDNs relative to var.dns_zone ("@" for its apex).
  mail_relative = !local.mail_dns_on ? {} : {
    for kind, fqdn in local.mail_fqdn :
    kind => fqdn == var.dns_zone.name ? "@" : trimsuffix(fqdn, ".${var.dns_zone.name}")
  }
}

resource "azurerm_email_communication_service" "this" {
  count = local.mail == null ? 0 : 1

  name                = "${local.name}-email"
  resource_group_name = local.resource_group_name
  data_location       = local.mail.data_location
  tags                = local.tags
}

resource "azurerm_email_communication_service_domain" "this" {
  count = local.mail == null ? 0 : 1

  name                             = local.mail.domain
  email_service_id                 = azurerm_email_communication_service.this[0].id
  domain_management                = "CustomerManaged"
  user_engagement_tracking_enabled = false
  tags                             = local.tags
}

resource "azurerm_email_communication_service_domain_sender_username" "this" {
  count = local.mail == null ? 0 : 1

  name                    = local.mail.username
  email_service_domain_id = azurerm_email_communication_service_domain.this[0].id
  display_name            = local.mail.from_name
}

resource "azurerm_communication_service" "this" {
  count = local.mail == null ? 0 : 1

  name                = "${local.global.hyphenated}-acs"
  resource_group_name = local.resource_group_name
  data_location       = local.mail.data_location
  tags                = local.tags
}

resource "azurerm_communication_service_email_domain_association" "this" {
  count = local.mail == null ? 0 : 1

  communication_service_id = azurerm_communication_service.this[0].id
  email_service_domain_id  = azurerm_email_communication_service_domain.this[0].id
}

# The domain's TXT records: ownership and SPF, on the domain's own name.
resource "azurerm_dns_txt_record" "mail" {
  count = local.mail_dns_on ? 1 : 0

  name                = local.mail_relative.domain
  zone_name           = var.dns_zone.name
  resource_group_name = var.dns_zone.resource_group_name
  ttl                 = 3600
  tags                = local.tags

  record {
    value = local.mail_records.domain[0].value
  }

  record {
    value = local.mail_records.spf[0].value
  }
}

# DKIM: two CNAMEs, named by Communication Services under the domain.
resource "azurerm_dns_cname_record" "mail_dkim" {
  for_each = local.mail_dns_on ? toset(["dkim", "dkim2"]) : toset([])

  name                = local.mail_relative[each.key]
  zone_name           = var.dns_zone.name
  resource_group_name = var.dns_zone.resource_group_name
  ttl                 = 3600
  record              = local.mail_records[each.key][0].value
  tags                = local.tags
}
