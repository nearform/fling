# A Fling instance on DigitalOcean: the Node host image (platforms/node/Dockerfile) on App Platform,
# its Table in Managed PostgreSQL and its site files in a private Spaces bucket. The design is
# docs/platforms/digitalocean-self-host.md; the guide is platforms/digitalocean/DEPLOY.md.
#
# Terraform owns the shape; the deploy workflow (.github/workflows/deploy-digitalocean.yml) owns
# the code: it pushes the image and points the service at its digest, which Terraform then ignores
# (with the tag).
#
# The generated secrets (session, site HMAC, tick) and the database and Spaces keys are in the app's
# encrypted environment and also in Terraform state: App Platform's env has no write-only argument.
# Keep the state in an encrypted backend that only the operators can read.

locals {
  app_region   = regex("^[a-z]+", var.region)
  bucket       = coalesce(var.bucket_name, "${var.name}-sites")
  cookie       = coalesce(var.site_cookie_domain, var.sites_domain)
  app_origin   = "https://${var.app_host}"
  s3_endpoint  = "https://${var.region}.digitaloceanspaces.com"
  shared_host  = var.app_host == var.sites_domain
  service_name = "fling"
  ingress_host = trimsuffix(trimprefix(digitalocean_app.fling.default_ingress, "https://"), "/")
  repository   = "fling-node"

  # One wildcard entry covers the app host and its sites when they are the same name; otherwise the
  # app host is the primary domain and the sites domain a wildcard alias.
  domains = local.shared_host ? [
    { name = var.app_host, type = "PRIMARY", wildcard = true },
    ] : [
    { name = var.app_host, type = "PRIMARY", wildcard = false },
    { name = var.sites_domain, type = "ALIAS", wildcard = true },
  ]

  # The database user's password goes into the URL, so it is URL-encoded. No sslmode: the host
  # verifies the cluster's certificate against DATABASE_CA_CERT. A direct connection, never a
  # pool in transaction mode (the migrations' lock and the live rooms' LISTEN hold a session).
  database_url = format(
    "postgres://%s:%s@%s:%d/%s",
    digitalocean_database_user.fling.name,
    urlencode(digitalocean_database_user.fling.password),
    digitalocean_database_cluster.fling.host,
    digitalocean_database_cluster.fling.port,
    digitalocean_database_db.fling.name,
  )

  general_env = merge(var.instance, {
    APP_ENV            = "production"
    APP_ORIGIN         = local.app_origin
    SITES_DOMAIN       = var.sites_domain
    SITE_COOKIE_DOMAIN = local.cookie
    LIVE_URL           = "wss://${var.app_host}/api/live"
    STORAGE_DRIVER     = "s3"
    SITES_BUCKET       = digitalocean_spaces_bucket.sites.name
    S3_ENDPOINT        = local.s3_endpoint
    S3_REGION          = var.region
    # Every S3-compatible store checks Content-MD5; Spaces' check of a signed
    # x-amz-checksum-sha256 is unconfirmed.
    S3_UPLOAD_DIGEST = "md5"
    DATABASE_CA_CERT = data.digitalocean_database_ca.fling.certificate
  })

  secret_env = {
    DATABASE_URL         = local.database_url
    S3_ACCESS_KEY_ID     = digitalocean_spaces_key.fling.access_key
    S3_SECRET_ACCESS_KEY = digitalocean_spaces_key.fling.secret_key
    SESSION_SECRET       = random_password.session.result
    SITE_HMAC_KEY        = random_password.site_hmac.result
    TICK_SECRET          = random_password.tick.result
  }
}

resource "random_password" "session" {
  length  = 48
  special = false
}

resource "random_password" "site_hmac" {
  length  = 48
  special = false
}

# The bearer token of POST /ticks/*: the deploy workflow runs the data migrations with it.
resource "random_password" "tick" {
  length  = 48
  special = false
}

resource "digitalocean_app" "fling" {
  spec {
    name   = var.name
    region = local.app_region
    # App Platform's edge cache keys on the URL alone, and a site's URL serves whichever version
    # is live: cached, a rollback or a new version would wait out the cache. The Node host makes
    # every routing decision itself, so nothing is cached in front of it.
    disable_edge_cache = true

    dynamic "domain" {
      for_each = local.domains
      content {
        name     = domain.value.name
        type     = domain.value.type
        wildcard = domain.value.wildcard
        zone     = var.dns_zone
      }
    }

    alert {
      rule = "DEPLOYMENT_FAILED"
      dynamic "destinations" {
        for_each = length(var.alert_emails) > 0 ? [1] : []
        content {
          emails = var.alert_emails
        }
      }
    }

    alert {
      rule = "DOMAIN_FAILED"
      dynamic "destinations" {
        for_each = length(var.alert_emails) > 0 ? [1] : []
        content {
          emails = var.alert_emails
        }
      }
    }

    service {
      name               = local.service_name
      instance_size_slug = var.instance_size_slug
      instance_count     = var.instance_count
      http_port          = 8080

      image {
        registry_type = "DOCR"
        repository    = local.repository
        tag           = var.image_tag
      }

      # The host answers /healthz on any host name that is neither the app's nor a site's.
      health_check {
        http_path             = "/healthz"
        initial_delay_seconds = 10
        period_seconds        = 10
      }

      dynamic "env" {
        for_each = local.general_env
        content {
          key   = env.key
          value = env.value
          scope = "RUN_TIME"
          type  = "GENERAL"
        }
      }

      # The keys are names, not secrets; only the values are.
      dynamic "env" {
        for_each = toset(concat(keys(local.secret_env), nonsensitive(keys(var.instance_secrets))))
        content {
          key   = env.value
          value = merge(var.instance_secrets, local.secret_env)[env.value]
          scope = "RUN_TIME"
          type  = "SECRET"
        }
      }
    }

    ingress {
      rule {
        component {
          name                 = local.service_name
          preserve_path_prefix = true
        }
        match {
          path {
            prefix = "/"
          }
        }
      }
    }
  }

  lifecycle {
    # The deploy workflow pins each release's image by digest (see the header), in place of the
    # tag the app was created with.
    ignore_changes = [spec[0].service[0].image[0].tag, spec[0].service[0].image[0].digest]
  }

  depends_on = [digitalocean_container_registry.fling]
}
