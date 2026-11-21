# The app's secrets are Secret Manager secrets named <namespace>-<env>-<name>-<secret>. Cloud Run
# puts each one's latest version in the service's environment when an instance starts (api.tf), as
# the secret's name in upper case (session-secret: SESSION_SECRET), so the service reads no secret
# through an API. No value is in Terraform state.
#
# - generated_secrets: 40 random characters, generated in memory (ephemeral) and written with a
#   write-only attribute. Bump secrets_version to regenerate them.
# - manual_secrets (and smtp-password, with var.mail): created with the placeholder "unset", which
#   the service reads as not set. Someone adds the real value as a new version
#   (gcloud secrets versions add); Terraform never reads it back, so that is not drift.
#
# A new version reaches instances that start after it: deploy again to replace the running ones.

locals {
  manual_secrets = distinct(concat(var.manual_secrets, var.mail == null ? [] : ["smtp-password"]))
  secrets        = toset(concat(var.generated_secrets, local.manual_secrets))
}

resource "google_secret_manager_secret" "this" {
  for_each = local.secrets

  project   = var.project_id
  secret_id = "${local.name}-${each.key}"

  replication {
    auto {}
  }

  labels = { app = var.name, env = var.env }

  depends_on = [google_project_service.this]
}

ephemeral "random_password" "generated" {
  for_each = toset(var.generated_secrets)

  length  = 40
  special = false
}

resource "google_secret_manager_secret_version" "generated" {
  for_each = toset(var.generated_secrets)

  secret                 = google_secret_manager_secret.this[each.key].id
  secret_data_wo         = ephemeral.random_password.generated[each.key].result
  secret_data_wo_version = var.secrets_version
}

resource "google_secret_manager_secret_version" "manual" {
  for_each = toset(local.manual_secrets)

  secret = google_secret_manager_secret.this[each.key].id
  # A placeholder, written once. The real value goes in with gcloud secrets versions add.
  secret_data_wo         = "unset"
  secret_data_wo_version = 1

  # The real value is a later version; this one may be disabled or destroyed by then.
  lifecycle {
    ignore_changes = [enabled]
  }
}

resource "google_secret_manager_secret_iam_member" "service" {
  for_each = local.secrets

  project   = var.project_id
  secret_id = google_secret_manager_secret.this[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.service.email}"
}
