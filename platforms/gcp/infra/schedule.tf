# The ticks: Cloud Scheduler calls the service's tick endpoints through the load balancer (the
# service answers only its own hostname), with a Google-signed ID token for the scheduler's service
# account and the app origin as its audience, which the service checks (platforms/gcp/src/ticks.ts).
# Every tick is safe to repeat, so a retried or doubled call does no harm.
#
# - maintain: every 15 minutes (var.maintenance_schedule), up to 4 minutes a run: the sites queued
#   for maintenance, then a sweep of every site (version retention, replaced home pages), and the
#   revocation sweep.
# - notify: every minute, with var.mail only: drains the notifications outbox.

locals {
  ticks = merge(
    { maintain = { schedule = var.maintenance_schedule, deadline = "300s" } },
    var.mail == null ? {} : { notify = { schedule = "* * * * *", deadline = "60s" } },
  )
}

resource "google_cloud_scheduler_job" "tick" {
  for_each = local.ticks

  project          = var.project_id
  region           = var.region
  name             = "${local.name}-${each.key}"
  description      = "${var.name} (${var.env}): POST /ticks/${each.key}."
  schedule         = each.value.schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = each.value.deadline

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "${local.url}/ticks/${each.key}"

    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.url
    }
  }

  depends_on = [google_project_service.this]
}
