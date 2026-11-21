# The edge: Front Door Standard in front of the app, for TLS, the wildcard domain and caching. Its
# rules engine runs no code, so the routing decision runs in the app (the Node host's sites host).
#
# - Two custom domains, the hostname and *.<sites_domain>, each with a Front Door managed
#   certificate (a wildcard one included), validated by the `_dnsauth` TXT records (dns.tf).
#   When the hostname is the sites domain, both validate at the same name.
# - One route, `/*` on both domains, HTTPS only, to the app's ingress. Front Door caches what the
#   app marks cacheable, keyed on the query string, for the response's s-maxage, else its max-age;
#   no rule overrides that, and Front Door never stores `private`, `no-cache` or `no-store` even
#   when one does. The app keeps sites-host responses to at most 60 s here and makes a response
#   to a site cookie `private` (src/front-door.ts, edgeCacheControl).
# - A rule set writes two headers on every request it forwards, overwriting any the visitor sent:
#   X-Origin-Verify (the origin-verify secret), which the app refuses requests without, and
#   X-Fling-Host (the host name the visitor asked for), which the app routes by, since Front Door
#   sends the app's own hostname as Host. The app never reads X-Forwarded-Host: Front Door appends
#   to one the visitor sends.

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

    request_header_action {
      header_action = "Overwrite"
      header_name   = "X-Fling-Host"
      value         = "{hostname}"
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
