# The app, planned against mocked providers: no DigitalOcean account or token needed
# (scripts/check-terraform.mjs runs it in the gate). The domains (one wildcard entry when the sites
# share the app's host, a primary and a wildcard alias otherwise), the Node host's environment
# (storage, database, generated secrets as SECRET), the instance's own values and its scale.

mock_provider "digitalocean" {
  override_during = plan

  mock_resource "digitalocean_database_user" {
    defaults = { password = "example/password" }
  }
  mock_resource "digitalocean_database_cluster" {
    defaults = {
      id   = "c0ffee00-0000-4000-8000-000000000001"
      host = "fling-db-do-user-1-0.example.db.ondigitalocean.com"
      port = 25060
    }
  }
  mock_resource "digitalocean_spaces_key" {
    defaults = {
      access_key = "DO00EXAMPLEACCESSKEY"
      secret_key = "example-secret-key"
    }
  }
  mock_resource "digitalocean_app" {
    defaults = {
      id              = "a11ce000-0000-4000-8000-000000000002"
      default_ingress = "https://fling-abc12.ondigitalocean.app"
    }
  }
  mock_data "digitalocean_database_ca" {
    defaults = {
      certificate = "-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----\n"
    }
  }
}

mock_provider "random" {}

variables {
  app_host      = "fling.example.test"
  sites_domain  = "fling.example.test"
  dns_zone      = "example.test"
  image_tag     = "0.14.0"
  registry_name = "example-registry"
  instance = {
    INSTANCE_NAME         = "Example Fling"
    ALLOWED_EMAIL_DOMAINS = "example.test"
  }
  instance_secrets = {
    OIDC_CLIENT_SECRET = "example-oidc-secret"
  }
}

run "sites_on_the_app_host" {
  command = plan

  assert {
    condition     = length(digitalocean_app.fling.spec[0].domain) == 1
    error_message = "one wildcard domain covers the app host and its sites"
  }

  assert {
    condition = alltrue([for d in digitalocean_app.fling.spec[0].domain :
    d.name == "fling.example.test" && d.type == "PRIMARY" && d.wildcard && d.zone == "example.test"])
    error_message = "the shared domain is the primary, a wildcard, in the DigitalOcean zone"
  }

  assert {
    condition     = digitalocean_app.fling.spec[0].disable_edge_cache
    error_message = "nothing is cached in front of the Node host"
  }

  assert {
    condition     = digitalocean_app.fling.spec[0].region == "ams"
    error_message = "the app runs in the datacentre's region"
  }
}

run "sites_on_their_own_domain" {
  command = plan

  variables {
    sites_domain = "sites.example.test"
  }

  assert {
    condition     = length(digitalocean_app.fling.spec[0].domain) == 2
    error_message = "the app host and the sites domain are two entries"
  }

  assert {
    condition = alltrue([for d in digitalocean_app.fling.spec[0].domain :
      d.name == "fling.example.test" ? (d.type == "PRIMARY" && !d.wildcard) :
    (d.name == "sites.example.test" && d.type == "ALIAS" && d.wildcard)])
    error_message = "the app host is primary and exact; the sites domain is a wildcard alias"
  }
}

run "environment" {
  command = plan

  variables {
    instance_count = 3
  }

  assert {
    condition     = digitalocean_app.fling.spec[0].service[0].instance_count == 3
    error_message = "instance_count scales the Node host"
  }

  assert {
    condition = alltrue([for e in digitalocean_app.fling.spec[0].service[0].env : (
      contains(["DATABASE_URL", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "SESSION_SECRET",
      "SITE_HMAC_KEY", "TICK_SECRET", "OIDC_CLIENT_SECRET"], e.key) ? e.type == "SECRET" : e.type == "GENERAL"
    )])
    error_message = "the secrets are SECRET, everything else GENERAL"
  }

  assert {
    condition = length(setsubtract(
      ["APP_ENV", "APP_ORIGIN", "SITES_DOMAIN", "SITE_COOKIE_DOMAIN", "LIVE_URL", "STORAGE_DRIVER",
        "SITES_BUCKET", "S3_ENDPOINT", "S3_REGION", "S3_UPLOAD_DIGEST", "DATABASE_CA_CERT",
        "DATABASE_URL", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "SESSION_SECRET",
      "SITE_HMAC_KEY", "TICK_SECRET", "INSTANCE_NAME", "ALLOWED_EMAIL_DOMAINS", "OIDC_CLIENT_SECRET"],
      [for e in digitalocean_app.fling.spec[0].service[0].env : e.key]
    )) == 0
    error_message = "the Node host gets its storage, database, secrets and the instance's values"
  }

  assert {
    condition = alltrue([for e in digitalocean_app.fling.spec[0].service[0].env : (
      e.key == "STORAGE_DRIVER" ? e.value == "s3" :
      e.key == "S3_ENDPOINT" ? e.value == "https://ams3.digitaloceanspaces.com" :
      e.key == "S3_UPLOAD_DIGEST" ? e.value == "md5" :
      e.key == "APP_ORIGIN" ? e.value == "https://fling.example.test" :
      e.key == "LIVE_URL" ? e.value == "wss://fling.example.test/api/live" :
      e.key == "SITES_BUCKET" ? e.value == "fling-sites" : true
    )])
    error_message = "the storage and address settings"
  }

  assert {
    condition = alltrue([for e in digitalocean_app.fling.spec[0].service[0].env :
      e.key != "DATABASE_URL" || (
        startswith(nonsensitive(e.value), "postgres://fling:example%2Fpassword@") &&
        endswith(nonsensitive(e.value), "@fling-db-do-user-1-0.example.db.ondigitalocean.com:25060/fling")
    )])
    error_message = "DATABASE_URL is a direct connection to the cluster, without sslmode"
  }

  assert {
    condition     = digitalocean_spaces_bucket.sites.acl == "private"
    error_message = "the bucket is private"
  }
}

run "site_servers_stay_off" {
  command = plan

  variables {
    instance = { SERVERS = "members" }
  }

  expect_failures = [var.instance]
}

run "module_owned_keys_refused" {
  command = plan

  variables {
    instance = { DATABASE_URL = "postgres://elsewhere" }
  }

  expect_failures = [var.instance]
}
