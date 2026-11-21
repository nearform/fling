# One Google-managed certificate for the hostname and *.<hostname>, from Certificate Manager. A DNS
# authorisation proves the domain (its CNAME record, dns.tf or yours), which is what a wildcard
# needs, and lets the certificate be issued before the hostname points at the load balancer. The
# load balancer takes it through a certificate map.

resource "google_certificate_manager_dns_authorization" "this" {
  project = var.project_id
  name    = local.name
  domain  = var.hostname

  depends_on = [google_project_service.this]
}

resource "google_certificate_manager_certificate" "this" {
  project = var.project_id
  name    = local.name
  scope   = "DEFAULT"

  managed {
    domains            = [var.hostname, "*.${var.hostname}"]
    dns_authorizations = [google_certificate_manager_dns_authorization.this.id]
  }
}

resource "google_certificate_manager_certificate_map" "this" {
  project = var.project_id
  name    = local.name
}

resource "google_certificate_manager_certificate_map_entry" "this" {
  for_each = {
    app   = var.hostname
    sites = "*.${var.hostname}"
  }

  project      = var.project_id
  name         = "${local.name}-${each.key}"
  map          = google_certificate_manager_certificate_map.this.name
  hostname     = each.value
  certificates = [google_certificate_manager_certificate.this.id]
}
