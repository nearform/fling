# The module, planned against mocked providers: no Google Cloud project or credentials needed
# (scripts/check-terraform.mjs runs it in the gate). The service's environment and secrets, live
# rooms and scaling, the schedules with and without mail, the backends with and without Cloud CDN,
# DNS with and without a zone, and the inputs it refuses.

mock_provider "google" {
  mock_resource "google_certificate_manager_dns_authorization" {
    defaults = {
      id = "projects/example-project/locations/global/dnsAuthorizations/example-production-fling"
      dns_resource_record = [{
        name = "_acme-challenge.fling.example.test."
        type = "CNAME"
        data = "0000.authorize.certificatemanager.goog."
      }]
    }
  }
  mock_resource "google_service_account" {
    defaults = {
      email = "example@example-project.iam.gserviceaccount.com"
      name  = "projects/example-project/serviceAccounts/example@example-project.iam.gserviceaccount.com"
    }
  }
  mock_resource "google_compute_global_address" {
    defaults = { address = "192.0.2.1" }
  }
  mock_data "google_dns_managed_zone" {
    defaults = { name = "example-test", dns_name = "example.test." }
  }
}

mock_provider "google-beta" {}

# random is the real provider: it generates the secrets in memory, offline.

variables {
  project_id    = "example-project"
  region        = "europe-west1"
  namespace     = "example"
  env           = "production"
  bucket_prefix = "example-test-"
  hostname      = "fling.example.test"
  github = {
    owner    = "example-org"
    owner_id = "1000001"
    repo     = "fling"
    repo_id  = "2000002"
  }
}

run "defaults" {
  command = plan

  assert {
    condition     = google_cloud_run_v2_service.api.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
    error_message = "The service takes traffic from the load balancer only."
  }

  assert {
    condition = alltrue([
      for k, v in {
        APP_ORIGIN   = "https://fling.example.test"
        SITES_DOMAIN = "fling.example.test"
        SITE_SCHEME  = "https"
        LIVE_URL     = "wss://fling.example.test/api/live"
        SITES_BUCKET = "example-test-example-production-fling-sites"
        TABLE_NAME   = "items"
      } : local.environment[k] == v
    ])
    error_message = "The service's environment comes from the module's inputs."
  }

  assert {
    condition     = google_cloud_run_v2_service.api.template[0].scaling[0].max_instance_count == 1
    error_message = "Live rooms run on one instance."
  }

  assert {
    condition     = length([for k in keys(local.environment) : k if can(regex("^(MAIL|SMTP)_", k))]) == 0
    error_message = "Without mail, the service has no mail settings."
  }

  assert {
    condition     = keys(google_cloud_scheduler_job.tick) == ["maintain"]
    error_message = "Without mail, only maintenance is scheduled."
  }

  assert {
    condition     = google_cloud_scheduler_job.tick["maintain"].http_target[0].uri == "https://fling.example.test/ticks/maintain"
    error_message = "Ticks go to the app's hostname, through the load balancer."
  }

  assert {
    condition     = google_cloud_scheduler_job.tick["maintain"].http_target[0].oidc_token[0].audience == "https://fling.example.test"
    error_message = "The ticks' ID tokens are for the app origin, which the service checks."
  }

  assert {
    condition = (
      local.secret_environment["SESSION_SECRET"] == "session-secret" &&
      local.secret_environment["SITE_HMAC_KEY"] == "site-hmac-key" &&
      local.secret_environment["OIDC_CLIENT_SECRET"] == "oidc-client-secret"
    )
    error_message = "Each secret reaches the service as its name in upper case."
  }

  assert {
    condition     = !contains(keys(google_secret_manager_secret.this), "smtp-password")
    error_message = "Without mail there is no SMTP password."
  }

  assert {
    condition     = !google_compute_backend_service.sites.enable_cdn && !google_compute_backend_service.app.enable_cdn
    error_message = "Cloud CDN is off by default."
  }

  assert {
    condition     = length(google_dns_record_set.this) == 0 && length(output.dns_records) == 5
    error_message = "Without a zone the module makes no records and lists the five it needs."
  }

  assert {
    condition     = output.deploy.APP_ORIGIN == "https://fling.example.test" && !contains(keys(output.deploy), "INSTANCE")
    error_message = "The deploy output has no INSTANCE without var.instance."
  }

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "assertion.repository_owner_id == '1000001' && assertion.repository_id == '2000002' && assertion.environment == 'gcp'"
    error_message = "Only the repository's gcp environment may deploy."
  }
}

run "with_mail_cdn_zone_and_instance" {
  command = plan

  variables {
    dns_zone = "example-test"
    cdn      = true
    instance = { ALLOWED_EMAIL_DOMAINS = "example.test" }
    mail = {
      from = "Fling@Mail.Fling.Example.Test"
      smtp = { host = "smtp.example.test", user = "apikey" }
    }
  }

  assert {
    condition = alltrue([
      for k, v in {
        MAIL_DRIVER = "smtp"
        MAIL_FROM   = "fling@mail.fling.example.test"
        SMTP_HOST   = "smtp.example.test"
        SMTP_PORT   = "587"
        SMTP_USER   = "apikey"
      } : local.environment[k] == v
    ])
    error_message = "With mail, the service sends through the SMTP server."
  }

  assert {
    condition     = local.secret_environment["SMTP_PASSWORD"] == "smtp-password"
    error_message = "With mail, the SMTP password is a secret to fill."
  }

  assert {
    condition     = google_cloud_scheduler_job.tick["notify"].schedule == "* * * * *"
    error_message = "With mail, the notifications drain every minute."
  }

  assert {
    condition     = google_compute_backend_service.sites.enable_cdn && !google_compute_backend_service.app.enable_cdn
    error_message = "Cloud CDN caches the sites, never the app."
  }

  assert {
    condition     = google_compute_backend_service.sites.cdn_policy[0].max_ttl == 60
    error_message = "Cloud CDN keeps a site's file at most a minute: its URL stays the same across versions."
  }

  assert {
    condition     = length(google_dns_record_set.this) == 5
    error_message = "With a zone the module makes the records."
  }

  assert {
    condition     = output.deploy.INSTANCE.ALLOWED_EMAIL_DOMAINS == "example.test"
    error_message = "var.instance becomes INSTANCE in the deploy output."
  }
}

run "scaled_out_without_live" {
  command = plan

  variables {
    live    = false
    service = { max_instances = 4 }
  }

  assert {
    condition     = !contains(keys(local.environment), "LIVE_URL") && output.live_url == null
    error_message = "Without live rooms there is no LIVE_URL."
  }

  assert {
    condition     = google_cloud_run_v2_service.api.template[0].scaling[0].max_instance_count == 4
    error_message = "Without live rooms the service scales out."
  }
}

run "refuses_live_on_several_instances" {
  command = plan

  variables {
    service = { max_instances = 2 }
  }

  expect_failures = [google_cloud_run_v2_service.api]
}

run "refuses_mail_settings_outside_var_mail" {
  command = plan

  variables {
    environment = { SMTP_HOST = "smtp.example.test" }
  }

  expect_failures = [var.environment]
}
