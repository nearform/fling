# The edge: Front Door Standard in front of the app, for TLS, the wildcard domain and caching. Its
# rules engine runs no code, so the routing decision runs in the app (the Node host's sites host).
#
# - Two custom domains, the hostname and *.<sites_domain>, each with a Front Door managed
#   certificate (a wildcard one included), validated by the `_dnsauth` TXT records (dns.tf).
#   When the hostname is the sites domain, both validate at the same name.
# - One route, `/*` on both domains, HTTPS only, to the app's ingress. Front Door caches what the
#   app marks cacheable (public sites' files and the UI's hashed assets), keyed on the query
#   string; everything private is `no-store` or `private` at the origin.
# - A rule set adds X-Origin-Verify (the origin-verify secret) to every request it forwards; the
#   app refuses requests without it. Front Door also forwards the visitor's Host as
#   X-Forwarded-Host, since it sends the app's own hostname as Host.

locals {
  # Front Door resource names: letters, digits and hyphens.
  domains = {
    app   = var.hostname
    sites = "*.${local.sites_domain}"
  }
}

resource "azurerm_cdn_frontdoor_profile" "this" {
  name                     = local.name
  resource_group_name      = local.resource_group_name
  sku_name                 = "Standard_AzureFrontDoor"
  response_timeout_seconds = 120
  tags                     = local.tags
}

resource "azurerm_cdn_frontdoor_endpoint" "this" {
  name                     = local.global.hyphenated
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  tags                     = local.tags
}

resource "azurerm_cdn_frontdoor_origin_group" "app" {
  name                     = "app"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  session_affinity_enabled = false

  load_balancing {
    sample_size                 = 4
    successful_samples_required = 3
  }
}

resource "azurerm_cdn_frontdoor_origin" "app" {
  name                          = "app"
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.app.id
  enabled                       = true

  host_name                      = azurerm_container_app.app.ingress[0].fqdn
  origin_host_header             = azurerm_container_app.app.ingress[0].fqdn
  https_port                     = 443
  http_port                      = 80
  certificate_name_check_enabled = true
  priority                       = 1
  weight                         = 1000
}

resource "azurerm_cdn_frontdoor_custom_domain" "this" {
  for_each = local.domains

  name                     = "${local.name}-${each.key}"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
  host_name                = each.value
  dns_zone_id              = local.dns_zone_id

  tls {
    certificate_type = "ManagedCertificate"
  }
}

resource "azurerm_cdn_frontdoor_rule_set" "origin" {
  name                     = "origin"
  cdn_frontdoor_profile_id = azurerm_cdn_frontdoor_profile.this.id
}

resource "azurerm_cdn_frontdoor_rule" "origin_verify" {
  name                      = "originverify"
  cdn_frontdoor_rule_set_id = azurerm_cdn_frontdoor_rule_set.origin.id
  order                     = 1
  behavior_on_match         = "Continue"

  actions {
    request_header_action {
      header_action = "Overwrite"
      header_name   = "X-Origin-Verify"
      value         = random_password.origin_verify.result
    }
  }
}

resource "azurerm_cdn_frontdoor_route" "app" {
  name                          = "app"
  cdn_frontdoor_endpoint_id     = azurerm_cdn_frontdoor_endpoint.this.id
  cdn_frontdoor_origin_group_id = azurerm_cdn_frontdoor_origin_group.app.id
  cdn_frontdoor_origin_ids      = [azurerm_cdn_frontdoor_origin.app.id]
  cdn_frontdoor_rule_set_ids    = [azurerm_cdn_frontdoor_rule_set.origin.id]

  cdn_frontdoor_custom_domain_ids = [for d in azurerm_cdn_frontdoor_custom_domain.this : d.id]
  link_to_default_domain          = false

  patterns_to_match      = ["/*"]
  supported_protocols    = ["Http", "Https"]
  https_redirect_enabled = true
  forwarding_protocol    = "HttpsOnly"

  cache {
    query_string_caching_behavior = "UseQueryString"
    compression_enabled           = true
    content_types_to_compress = [
      "application/javascript",
      "application/json",
      "application/xml",
      "image/svg+xml",
      "text/css",
      "text/html",
      "text/javascript",
      "text/plain",
    ]
  }

  depends_on = [azurerm_cdn_frontdoor_rule.origin_verify]
}

resource "azurerm_cdn_frontdoor_custom_domain_association" "this" {
  for_each = local.domains

  cdn_frontdoor_custom_domain_id = azurerm_cdn_frontdoor_custom_domain.this[each.key].id
  cdn_frontdoor_route_ids        = [azurerm_cdn_frontdoor_route.app.id]
}
