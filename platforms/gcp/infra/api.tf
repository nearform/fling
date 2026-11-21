# The Cloud Run service: the Node host with the GCP adapters (platforms/gcp/src/main.ts), answering
# the app host and every site. It takes traffic only from the load balancer (ingress
# internal-and-cloud-load-balancing), so its run.app URL is closed to the internet and no origin
# secret is needed; callers need no IAM (invoker_iam_disabled), as the app checks who they are.
#
# The image is the deploy's: Terraform starts with a placeholder and ignores the image afterwards.

# The service's environment: the deployment plumbing, from the module's inputs. The instance's own
# values (INSTANCE_NAME, ALLOWED_EMAIL_DOMAINS…) come from var.instance through the deploy, written
# into the image. var.environment can set or override any key here except the four the module owns.
# LIVE_URL is set only with live rooms on one instance (var.live); MAIL_* and SMTP_* only from
# var.mail.
locals {
  environment = merge(
    {
      APP_ENV            = "production"
      APP_ORIGIN         = local.url
      SITES_DOMAIN       = var.hostname
      SITE_SCHEME        = "https"
      SITE_COOKIE_DOMAIN = ".${var.hostname}"
    },
    local.live_on ? { LIVE_URL = local.live_url } : {},
    var.environment,
    {
      FIRESTORE_DATABASE    = google_firestore_database.this.name
      TABLE_NAME            = local.collection
      SITES_BUCKET          = google_storage_bucket.sites.name
      TICK_SERVICE_ACCOUNTS = join(",", [google_service_account.scheduler.email, google_service_account.deploy.email])
    },
    local.mail_environment,
  )

  mail_environment = var.mail == null ? {} : {
    for k, v in {
      MAIL_DRIVER    = "smtp"
      MAIL_FROM      = lower(var.mail.from)
      MAIL_FROM_NAME = var.mail.from_name
      MAIL_REPLY_TO  = var.mail.reply_to
      SMTP_HOST      = var.mail.smtp.host
      SMTP_PORT      = tostring(var.mail.smtp.port)
      SMTP_SECURITY  = var.mail.smtp.security
      SMTP_USER      = var.mail.smtp.user
    } : k => v if v != null
  }

  # Each secret as the environment variable the core reads (session-secret: SESSION_SECRET).
  secret_environment = { for s in local.secrets : upper(replace(s, "-", "_")) => s }

  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello"
}

resource "google_cloud_run_v2_service" "api" {
  project              = var.project_id
  name                 = local.name
  location             = var.region
  description          = "${var.name} (${var.env}). Image deployed by ${var.github.owner}/${var.github.repo}."
  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  invoker_iam_disabled = true
  deletion_protection  = false

  template {
    service_account                  = google_service_account.service.email
    timeout                          = "${var.service.timeout_seconds}s"
    max_instance_request_concurrency = var.service.concurrency

    scaling {
      min_instance_count = var.service.min_instances
      max_instance_count = var.service.max_instances
    }

    containers {
      image = local.placeholder_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.service.cpu
          memory = var.service.memory
        }
        # CPU only while serving: the ticks are requests from Cloud Scheduler, not timers.
        cpu_idle          = true
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = local.environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secret_environment
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.this[env.value].secret_id
              version = "latest"
            }
          }
        }
      }
      # The default startup probe (TCP on the port): an HTTP one would be refused, since the host
      # answers only its own hostnames.
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]

    precondition {
      condition     = !(var.live && var.service.max_instances > 1)
      error_message = "Live rooms (var.live) need service.max_instances = 1; set live = false to scale out."
    }
  }

  depends_on = [
    google_project_service.this,
    google_secret_manager_secret_iam_member.service,
    google_secret_manager_secret_version.generated,
    google_secret_manager_secret_version.manual,
  ]
}
