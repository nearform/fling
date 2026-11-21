# Who may do what:
# - the service's account: the instance's Firestore database, the sites bucket (storage.tf), its
#   secrets (secrets.tf), and signing as itself, which is how it signs URLs (signBlob) without a key;
# - the scheduler's account: nothing; Cloud Scheduler mints ID tokens for it, which the service
#   checks;
# - the deploy's account, which GitHub Actions becomes through Workload Identity Federation: push
#   images to the repository, deploy the service (running as the service's account), and mint ID
#   tokens for itself, to call the migrate endpoint.

resource "google_service_account" "service" {
  project      = var.project_id
  account_id   = "${local.short}-run"
  display_name = "${var.name} (${var.env}) service"

  depends_on = [google_project_service.this]
}

resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = "${local.short}-tick"
  display_name = "${var.name} (${var.env}) ticks"

  depends_on = [google_project_service.this]
}

resource "google_service_account" "deploy" {
  project      = var.project_id
  account_id   = "${local.short}-ship"
  display_name = "${var.name} (${var.env}) deploy, from ${var.github.owner}/${var.github.repo}"

  depends_on = [google_project_service.this]
}

# Firestore's roles are project-wide; the condition holds the service to its own database.
resource "google_project_iam_member" "service_firestore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.service.email}"

  condition {
    title      = "${local.name} database"
    expression = "resource.name == \"projects/${var.project_id}/databases/${google_firestore_database.this.name}\""
  }
}

resource "google_service_account_iam_member" "service_signs_as_itself" {
  service_account_id = google_service_account.service.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.service.email}"
}

# -----------------------------------------------------------------------------
# GitHub Actions: the deploy workflow's OIDC token, from the named repository (by id) and GitHub
# environment only, exchanged for the deploy account.
# -----------------------------------------------------------------------------

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "${local.short}-gh"
  display_name              = "${var.name} (${var.env}) GitHub"
  description               = "GitHub Actions deploys of ${var.github.owner}/${var.github.repo}."

  depends_on = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub Actions"

  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.environment"         = "assertion.environment"
  }

  # Numeric ids survive a rename; the environment's protection rules decide who may deploy.
  attribute_condition = join(" && ", [
    "assertion.repository_owner_id == '${var.github.owner_id}'",
    "assertion.repository_id == '${var.github.repo_id}'",
    "assertion.environment == '${var.github.environment}'",
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

locals {
  github_principal = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.github.repo_id}"
}

resource "google_service_account_iam_member" "deploy_federation" {
  for_each = toset([
    "roles/iam.workloadIdentityUser",
    # The ID token for the migrate endpoint.
    "roles/iam.serviceAccountOpenIdTokenCreator",
  ])

  service_account_id = google_service_account.deploy.name
  role               = each.key
  member             = local.github_principal
}

resource "google_artifact_registry_repository_iam_member" "deploy" {
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deploy.email}"
}

resource "google_cloud_run_v2_service_iam_member" "deploy" {
  project  = var.project_id
  location = google_cloud_run_v2_service.api.location
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deploy.email}"
}

# A revision runs as the service's account: deploying one needs actAs on it.
resource "google_service_account_iam_member" "deploy_acts_as_service" {
  service_account_id = google_service_account.service.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy.email}"
}
