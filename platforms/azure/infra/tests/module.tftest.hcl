# The module planned against mocked providers: no Azure subscription or credentials needed
# (scripts/check-terraform.mjs runs it in the gate). The defaults, the jobs with and without mail,
# DNS with and without a zone (Front Door's validation tokens sharing one record set when the
# hostname is the sites domain, an alias record at a zone's apex) and the deploy output.
#
# Computed values are unknown in a plan, except those the assertions read, given below with ids in
# Azure's format (the provider parses an id it is handed).

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id       = "00000000-0000-0000-0000-000000000001"
      subscription_id = "00000000-0000-0000-0000-000000000002"
      object_id       = "00000000-0000-0000-0000-000000000003"
      client_id       = "00000000-0000-0000-0000-000000000004"
    }
  }
}

override_resource {
  target          = azurerm_web_pubsub.this
  override_during = plan
  values = {
    id       = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/example-production-fling/providers/Microsoft.SignalRService/webPubSub/example-production-fling-abc123"
    hostname = "example-production-fling-abc123.webpubsub.azure.com"
  }
}

override_resource {
  target          = azurerm_cdn_frontdoor_endpoint.this
  override_during = plan
  values = {
    id        = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/example-production-fling/providers/Microsoft.Cdn/profiles/example-production-fling/afdEndpoints/example-production-fling-abc123"
    host_name = "example-production-fling-abc123.z01.azurefd.net"
  }
}

override_resource {
  target          = azurerm_cdn_frontdoor_custom_domain.this["app"]
  override_during = plan
  values = {
    id               = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/example-production-fling/providers/Microsoft.Cdn/profiles/example-production-fling/customDomains/example-production-fling-app"
    validation_token = "token-app"
  }
}

override_resource {
  target          = azurerm_cdn_frontdoor_custom_domain.this["sites"]
  override_during = plan
  values = {
    id               = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/example-production-fling/providers/Microsoft.Cdn/profiles/example-production-fling/customDomains/example-production-fling-sites"
    validation_token = "token-sites"
  }
}

override_resource {
  target          = azurerm_communication_service.this[0]
  override_during = plan
  values = {
    id       = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/example-production-fling/providers/Microsoft.Communication/communicationServices/example-production-fling-abc123-acs"
    hostname = "example-production-fling-abc123-acs.europe.communication.azure.com"
  }
}

override_resource {
  target          = azurerm_email_communication_service_domain.this[0]
  override_during = plan
  values = {
    id = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/example-production-fling/providers/Microsoft.Communication/emailServices/example-production-fling-email/domains/mail.fling.example.test"
    verification_records = [{
      domain = [{ name = "@", type = "TXT", value = "ms-domain-verification=abc", ttl = 3600 }]
      spf    = [{ name = "@", type = "TXT", value = "v=spf1 include:spf.protection.outlook.com -all", ttl = 3600 }]
      dkim   = [{ name = "selector1-azurecomm-prod-net._domainkey", type = "CNAME", value = "selector1.example.azurecomm.net", ttl = 3600 }]
      dkim2  = [{ name = "selector2-azurecomm-prod-net._domainkey", type = "CNAME", value = "selector2.example.azurecomm.net", ttl = 3600 }]
      dmarc  = []
    }]
  }
}

variables {
  namespace = "example"
  env       = "production"
  location  = "westeurope"
  hostname  = "fling.example.test"
  github = {
    repository = "example-org/fling"
  }
}

run "defaults" {
  command = plan

  assert {
    condition     = toset(keys(azurerm_container_app_job.this)) == toset(["migrate", "maintain"])
    error_message = "Without mail there are the migrate and maintain jobs only."
  }

  assert {
    condition     = length(azurerm_communication_service.this) == 0 && length(azurerm_email_communication_service.this) == 0 && length(azurerm_role_assignment.app_mail) == 0
    error_message = "Without mail, mail.tf creates nothing."
  }

  assert {
    condition     = length([for k in keys(local.environment) : k if startswith(k, "MAIL_") || startswith(k, "ACS_")]) == 0
    error_message = "Without mail, the app gets no mail settings."
  }

  assert {
    condition = (
      local.environment.STORE_DRIVER == "cosmos" &&
      local.environment.STORAGE_DRIVER == "azure-blob" &&
      local.environment.KVS_DRIVER == "table" &&
      local.environment.APP_ORIGIN == "https://fling.example.test" &&
      local.environment.SITES_DOMAIN == "fling.example.test" &&
      local.environment.LIVE_URL == "wss://example-production-fling-abc123.webpubsub.azure.com/client/hubs/fling"
    )
    error_message = "The app's environment names the Azure drivers, the domains and the live rooms."
  }

  assert {
    condition     = toset(keys(local.secrets)) == toset(["session-secret", "site-hmac-key", "oidc-client-secret", "origin-verify-secret", "live-events-secret"])
    error_message = "The app references the generated, manual and module secrets from Key Vault."
  }

  assert {
    condition     = length(azurerm_dns_txt_record.validation) == 0 && length(azurerm_dns_cname_record.this) == 0 && length(azurerm_dns_a_record.apex) == 0
    error_message = "Without a DNS zone the module adds no records."
  }

  assert {
    condition = toset(keys(output.deploy)) == toset([
      "clientId", "tenantId", "subscriptionId", "resourceGroup", "registry", "repository",
      "containerApp", "jobs", "frontDoor", "appOrigin", "sitesDomain",
    ])
    error_message = "The deploy output has the keys deploy-azure.yml reads, and no INSTANCE when var.instance is empty."
  }

  assert {
    condition     = azurerm_federated_identity_credential.github.subject == "repo:example-org/fling:environment:azure"
    error_message = "Only the repository's deploy environment can sign in as the deploy identity."
  }

  assert {
    condition     = azurerm_cosmosdb_account.this.consistency_policy[0].consistency_level == "Strong"
    error_message = "The Table's races need Strong consistency."
  }

  assert {
    condition     = toset(azurerm_cosmosdb_sql_container.items.partition_key_paths) == toset(["/p"]) && azurerm_cosmosdb_sql_container.items.default_ttl == -1
    error_message = "One partition key path, /p, and TTL on."
  }
}

run "with_mail" {
  command = plan

  variables {
    mail     = { from_name = "Example Fling" }
    instance = { INSTANCE_NAME = "Example Fling" }
  }

  assert {
    condition     = azurerm_container_app_job.this["notify"].schedule_trigger_config[0].cron_expression == "* * * * *"
    error_message = "With mail, the notify job runs every minute."
  }

  assert {
    condition = (
      local.environment.MAIL_DRIVER == "acs" &&
      local.environment.MAIL_FROM == "fling@mail.fling.example.test" &&
      local.environment.ACS_ENDPOINT == "https://example-production-fling-abc123-acs.europe.communication.azure.com"
    )
    error_message = "With mail, the app sends through Communication Services from mail.<sites domain>."
  }

  assert {
    condition     = azurerm_email_communication_service_domain_sender_username.this[0].display_name == "Example Fling"
    error_message = "The sender's display name is the sender username's."
  }

  assert {
    condition     = output.deploy.INSTANCE.INSTANCE_NAME == "Example Fling"
    error_message = "var.instance becomes INSTANCE in the deploy output."
  }
}

run "dns_one_name" {
  command = plan

  variables {
    dns_zone = { name = "example.test", resource_group_name = "example-dns" }
    mail     = {}
  }

  assert {
    condition     = toset(keys(azurerm_dns_txt_record.validation)) == toset(["_dnsauth.fling"])
    error_message = "When the hostname is the sites domain, both validate at one name."
  }

  assert {
    condition     = length(azurerm_dns_txt_record.validation["_dnsauth.fling"].record) == 2
    error_message = "That one record set holds both tokens."
  }

  assert {
    condition     = toset([for r in azurerm_dns_cname_record.this : r.name]) == toset(["fling", "*.fling"])
    error_message = "The hostname and the wildcard point at Front Door."
  }

  assert {
    condition     = azurerm_dns_txt_record.mail[0].name == "mail.fling" && toset([for r in azurerm_dns_cname_record.mail_dkim : r.name]) == toset(["selector1-azurecomm-prod-net._domainkey.mail.fling", "selector2-azurecomm-prod-net._domainkey.mail.fling"])
    error_message = "The sending domain's records go under its name in the zone."
  }
}

run "dns_two_names" {
  command = plan

  variables {
    hostname     = "fling.example.test"
    sites_domain = "sites.example.test"
    dns_zone     = { name = "example.test", resource_group_name = "example-dns" }
  }

  assert {
    condition     = toset(keys(azurerm_dns_txt_record.validation)) == toset(["_dnsauth.fling", "_dnsauth.sites"])
    error_message = "A sites domain of its own validates at its own name."
  }

  assert {
    condition     = toset([for r in azurerm_dns_cname_record.this : r.name]) == toset(["fling", "*.sites"])
    error_message = "The hostname and the sites wildcard point at Front Door."
  }

  assert {
    condition     = local.environment.SITE_COOKIE_DOMAIN == ".sites.example.test"
    error_message = "The site cookie is set on the sites domain."
  }
}

run "dns_apex" {
  command = plan

  variables {
    hostname = "example.test"
    dns_zone = { name = "example.test", resource_group_name = "example-dns" }
  }

  assert {
    condition     = length(azurerm_dns_a_record.apex) == 1 && toset([for r in azurerm_dns_cname_record.this : r.name]) == toset(["*"])
    error_message = "The apex is an alias record to Front Door; the wildcard a CNAME."
  }

  assert {
    condition     = toset(keys(azurerm_dns_txt_record.validation)) == toset(["_dnsauth"])
    error_message = "The apex validates at _dnsauth."
  }
}
