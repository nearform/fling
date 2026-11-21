# DNS in an Azure DNS zone (var.dns_zone), when one is given:
# - `_dnsauth.<name>` TXT records validating Front Door's two custom domains. For *.<sites domain>
#   the record is `_dnsauth.<sites domain>`, so when the hostname is the sites domain both tokens
#   share one record set.
# - The hostname and *.<sites domain> pointing at the Front Door endpoint: a CNAME, or an alias A
#   record where the name is the zone's apex (an apex can't hold a CNAME).
# Without a zone, the dns_records output lists the same records to add wherever the domain is.

locals {
  dns_zone_id = (
    var.dns_zone == null ? null :
    "/subscriptions/${data.azurerm_client_config.current.subscription_id}/resourceGroups/${var.dns_zone.resource_group_name}/providers/Microsoft.Network/dnsZones/${var.dns_zone.name}"
  )

  # A name relative to the zone ("@" for its apex).
  zone_name = var.dns_zone == null ? "" : var.dns_zone.name
  relative = {
    for k, fqdn in { app = var.hostname, sites = local.sites_domain } :
    k => fqdn == local.zone_name ? "@" : trimsuffix(fqdn, ".${local.zone_name}")
  }
  dnsauth = { for k, r in local.relative : k => r == "@" ? "_dnsauth" : "_dnsauth.${r}" }

  # The validation records, by record name: one or two tokens each.
  validation = {
    for name in distinct(values(local.dnsauth)) :
    name => [for k, n in local.dnsauth : azurerm_cdn_frontdoor_custom_domain.this[k].validation_token if n == name]
  }

  # Where each name points.
  pointers = {
    app   = local.relative.app
    sites = local.relative.sites == "@" ? "*" : "*.${local.relative.sites}"
  }
}

resource "azurerm_dns_txt_record" "validation" {
  for_each = var.dns_zone == null ? {} : { for name in distinct(values(local.dnsauth)) : name => name }

  name                = each.key
  zone_name           = var.dns_zone.name
  resource_group_name = var.dns_zone.resource_group_name
  ttl                 = 3600
  tags                = local.tags

  dynamic "record" {
    for_each = local.validation[each.key]
    content {
      value = record.value
    }
  }
}

resource "azurerm_dns_cname_record" "this" {
  for_each = var.dns_zone == null ? {} : { for k, n in local.pointers : k => n if n != "@" }

  name                = each.value
  zone_name           = var.dns_zone.name
  resource_group_name = var.dns_zone.resource_group_name
  ttl                 = 3600
  record              = azurerm_cdn_frontdoor_endpoint.this.host_name
  tags                = local.tags
}

resource "azurerm_dns_a_record" "apex" {
  for_each = var.dns_zone == null ? {} : { for k, n in local.pointers : k => n if n == "@" }

  name                = "@"
  zone_name           = var.dns_zone.name
  resource_group_name = var.dns_zone.resource_group_name
  ttl                 = 3600
  target_resource_id  = azurerm_cdn_frontdoor_endpoint.this.id
  tags                = local.tags
}
