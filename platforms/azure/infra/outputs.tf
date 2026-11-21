output "url" {
  description = "Where the app is served."
  value       = local.url
}

output "deploy" {
  description = <<-EOT
    What the deploy workflow needs, set as ONE repository variable, AZURE_DEPLOY_CONFIG, holding this
    map as JSON: terraform output -json deploy | gh variable set AZURE_DEPLOY_CONFIG -R <owner>/<repo>.
    Includes INSTANCE when var.instance is set. Nothing here is secret.
  EOT
  value = merge(
    {
      clientId       = azurerm_user_assigned_identity.deploy.client_id
      tenantId       = data.azurerm_client_config.current.tenant_id
      subscriptionId = data.azurerm_client_config.current.subscription_id
      resourceGroup  = local.resource_group_name
      registry       = azurerm_container_registry.this.login_server
      repository     = "fling"
      containerApp   = azurerm_container_app.app.name
      jobs           = { for k, j in azurerm_container_app_job.this : k => j.name }
      frontDoor = {
        profile  = azurerm_cdn_frontdoor_profile.this.name
        endpoint = azurerm_cdn_frontdoor_endpoint.this.name
        domains  = values(local.domains)
      }
      appOrigin   = local.url
      sitesDomain = local.sites_domain
    },
    # Only when set, so an empty var.instance leaves the output as it was.
    { for k, v in { INSTANCE = var.instance } : k => v if length(v) > 0 },
  )
}

output "live_url" {
  description = "Where review pages open their live room's WebSocket (the app's LIVE_URL)."
  value       = local.live_url
}

output "key_vault" {
  description = "The Key Vault holding the app's secrets."
  value       = azurerm_key_vault.this.name
}

output "manual_secrets" {
  description = "Key Vault secrets that someone has to fill (az keyvault secret set)."
  value       = [for s in azurerm_key_vault_secret.manual : s.name]
}

output "dns_records" {
  description = <<-EOT
    The DNS records the instance needs, as FQDN, type and value: Front Door's validation TXT
    records, the hostname and the wildcard (CNAME to the endpoint; an apex needs an alias or
    ALIAS/ANAME record instead) and, with mail, the sending domain's. With var.dns_zone the module
    adds them itself.
  EOT
  value = concat(
    [for k, d in azurerm_cdn_frontdoor_custom_domain.this : {
      name  = "_dnsauth.${trimprefix(d.host_name, "*.")}"
      type  = "TXT"
      value = d.validation_token
    }],
    [for k, d in azurerm_cdn_frontdoor_custom_domain.this : {
      name  = d.host_name
      type  = "CNAME"
      value = azurerm_cdn_frontdoor_endpoint.this.host_name
    }],
    local.mail == null ? [] : [
      for kind in ["domain", "spf", "dkim", "dkim2"] : {
        name  = local.mail_fqdn[kind]
        type  = local.mail_records[kind][0].type
        value = local.mail_records[kind][0].value
      }
    ],
  )
}

output "mail_from" {
  description = "The sender address (MAIL_FROM); null without var.mail."
  value       = local.mail_from
}

output "log_analytics_workspace" {
  description = "The app's and the jobs' logs."
  value       = azurerm_log_analytics_workspace.this.name
}
