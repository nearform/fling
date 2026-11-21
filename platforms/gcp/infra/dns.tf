# DNS: the hostname and the wildcard point at the load balancer (A and AAAA), and the certificate's
# DNS authorisation is a CNAME. In Cloud DNS with var.dns_zone; without it, the same records are the
# dns_records output, for wherever the domain's DNS is.

locals {
  authorization = google_certificate_manager_dns_authorization.this.dns_resource_record[0]

  # Keyed by what each is (the values are only known after apply).
  dns_records = {
    app-a         = { name = "${var.hostname}.", type = "A", value = google_compute_global_address.ipv4.address }
    app-aaaa      = { name = "${var.hostname}.", type = "AAAA", value = google_compute_global_address.ipv6.address }
    sites-a       = { name = "*.${var.hostname}.", type = "A", value = google_compute_global_address.ipv4.address }
    sites-aaaa    = { name = "*.${var.hostname}.", type = "AAAA", value = google_compute_global_address.ipv6.address }
    authorization = { name = local.authorization.name, type = local.authorization.type, value = local.authorization.data }
  }
}

data "google_dns_managed_zone" "this" {
  count = var.dns_zone == null ? 0 : 1

  project = var.project_id
  name    = var.dns_zone
}

resource "google_dns_record_set" "this" {
  for_each = var.dns_zone == null ? {} : local.dns_records

  project      = var.project_id
  managed_zone = data.google_dns_managed_zone.this[0].name
  name         = each.value.name
  type         = each.value.type
  ttl          = 300
  rrdatas      = [each.value.value]
}
