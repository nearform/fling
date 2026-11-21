output "app_id" {
  description = "The App Platform app."
  value       = digitalocean_app.fling.id
}

output "default_ingress" {
  description = "The app's own address on ondigitalocean.app (the target of the DNS records)."
  value       = digitalocean_app.fling.default_ingress
}

output "live_url" {
  description = "The app's live URL (its primary domain once that is verified)."
  value       = digitalocean_app.fling.live_url
}

output "deploy" {
  description = "The deploy workflow's configuration: the JSON of this object is the DO_DEPLOY_CONFIG repository variable."
  value = {
    APP_ID     = digitalocean_app.fling.id
    APP_ORIGIN = local.app_origin
    REGISTRY   = var.registry_name
    REPOSITORY = local.repository
    SERVICE    = local.service_name
  }
}

output "tick_secret" {
  description = "The bearer token of POST /ticks/*: the FLING_TICK_SECRET secret of the deploy workflow."
  value       = random_password.tick.result
  sensitive   = true
}

output "dns" {
  description = "What DNS needs. With dns_zone, nothing: App Platform adds the records and verifies the certificates."
  value = var.dns_zone != null ? "App Platform manages ${var.app_host} and *.${var.sites_domain} in the ${var.dns_zone} domain." : join("\n", concat(
    ["Add at your DNS provider (CNAME to the app's ondigitalocean.app host):"],
    flatten([for d in local.domains : [
      for n in(d.wildcard ? [d.name, "*.${d.name}"] : [d.name]) : "  ${n} CNAME ${local.ingress_host}"
    ]]),
    ["and the TXT records the control panel shows for the wildcard certificate (Settings → Domains)."],
  ))
}
