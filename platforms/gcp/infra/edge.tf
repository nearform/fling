# The global external Application Load Balancer in front of the service: TLS for the hostname and
# every site (the certificate map, certs.tf), HTTP redirected to HTTPS, and two backends on one
# serverless NEG, so Cloud CDN (var.cdn) can be on for the sites and never for the app.
#
# WebSockets (live rooms) pass through; each lasts at most the service's request timeout, after
# which the page reconnects.

resource "google_compute_global_address" "ipv4" {
  project      = var.project_id
  name         = "${local.name}-ipv4"
  ip_version   = "IPV4"
  address_type = "EXTERNAL"

  depends_on = [google_project_service.this]
}

resource "google_compute_global_address" "ipv6" {
  project      = var.project_id
  name         = "${local.name}-ipv6"
  ip_version   = "IPV6"
  address_type = "EXTERNAL"

  depends_on = [google_project_service.this]
}

resource "google_compute_region_network_endpoint_group" "api" {
  project               = var.project_id
  name                  = local.name
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.api.name
  }
}

# The app: the API, the UI and the endpoints Cloud Scheduler calls. Never cached at the edge.
resource "google_compute_backend_service" "app" {
  project               = var.project_id
  name                  = "${local.name}-app"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  enable_cdn            = false

  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }

  log_config {
    enable      = true
    sample_rate = 1
  }
}

# The sites. With var.cdn, Cloud CDN caches what the service marks public: a public site's files.
# The service sends `private` for whatever only the access checks may hand out (a site that isn't
# public, a share link) and `no-store` for its 404s and sign-in hops, and a response that sets a
# cookie is never cached. The cache is keyed by the viewer's URL, which stays the same across
# versions, so max_ttl caps how long the edge keeps a file (the stored `s-maxage` is a year, for
# CloudFront's versioned keys): a publish, a rollback or a change of access reaches every viewer
# within local.cdn_ttl. CACHE_ALL_STATIC is the cache mode that takes a max_ttl; every file the
# service sends says how to cache it, so the mode's defaults for unmarked files never apply.
# client_ttl leaves the browser the max-age the service sends.
resource "google_compute_backend_service" "sites" {
  project               = var.project_id
  name                  = "${local.name}-sites"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  enable_cdn            = var.cdn

  backend {
    group = google_compute_region_network_endpoint_group.api.id
  }

  dynamic "cdn_policy" {
    for_each = var.cdn ? [1] : []
    content {
      cache_mode       = "CACHE_ALL_STATIC"
      default_ttl      = local.cdn_ttl
      max_ttl          = local.cdn_ttl
      client_ttl       = 31536000
      negative_caching = false
      cache_key_policy {
        include_host         = true
        include_protocol     = false
        include_query_string = true
      }
    }
  }

  log_config {
    enable      = true
    sample_rate = 1
  }
}

resource "google_compute_url_map" "https" {
  project         = var.project_id
  name            = "${local.name}-https"
  default_service = google_compute_backend_service.app.id

  host_rule {
    hosts        = ["*.${var.hostname}"]
    path_matcher = "sites"
  }

  path_matcher {
    name            = "sites"
    default_service = google_compute_backend_service.sites.id
  }
}

resource "google_compute_target_https_proxy" "this" {
  project         = var.project_id
  name            = "${local.name}-https"
  url_map         = google_compute_url_map.https.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.this.id}"
}

resource "google_compute_global_forwarding_rule" "https" {
  for_each = {
    ipv4 = google_compute_global_address.ipv4.address
    ipv6 = google_compute_global_address.ipv6.address
  }

  project               = var.project_id
  name                  = "${local.name}-https-${each.key}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = each.value
  port_range            = "443"
  target                = google_compute_target_https_proxy.this.id
}

# Plain HTTP only redirects.
resource "google_compute_url_map" "http" {
  project = var.project_id
  name    = "${local.name}-http"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "this" {
  project = var.project_id
  name    = "${local.name}-http"
  url_map = google_compute_url_map.http.id
}

resource "google_compute_global_forwarding_rule" "http" {
  for_each = {
    ipv4 = google_compute_global_address.ipv4.address
    ipv6 = google_compute_global_address.ipv6.address
  }

  project               = var.project_id
  name                  = "${local.name}-http-${each.key}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = each.value
  port_range            = "80"
  target                = google_compute_target_http_proxy.this.id
}
