# Fling on Google Cloud: one Cloud Run service (the Node host) that answers the app and every site,
# behind a global external Application Load Balancer. See ../DEPLOY.md and docs/platforms/gcp.md.
#
#   <hostname>, *.<hostname>  load balancer (Certificate Manager wildcard certificate)
#     ├─ <hostname>    → backend "app"   ─┐
#     └─ *.<hostname>  → backend "sites" ─┴─ serverless NEG → Cloud Run service (the Node host)
#                         (Cloud CDN with var.cdn)
#   Firestore (Native mode, one database), the sites bucket, Secret Manager, Cloud Scheduler.
#
# Who changes what:
# - Terraform owns the shape: the service's configuration and environment, the database and its
#   indexes, the bucket, the load balancer, the certificate, DNS, the schedules, the service
#   accounts and which secrets exist.
# - The deploy workflow (.github/workflows/deploy-gcp.yml) owns the code: the image. Terraform starts
#   the service with a placeholder image and ignores the image from then on, so a plan after a
#   deploy reads "No changes".
# - The app owns the documents and the objects.
#
# Resource names are <namespace>-<env>-<name> (e.g. acme-production-fling).

locals {
  name = "${var.namespace}-${var.env}-${var.name}"
  url  = "https://${var.hostname}"
  # Service account ids are at most 30 characters, workload identity pool ids 32.
  short = trimsuffix(substr(local.name, 0, 25), "-")

  firestore_location = coalesce(var.firestore_location, var.region)

  # Every socket of a live room must reach one process: only with one instance.
  live_on  = var.live && var.service.max_instances == 1
  live_url = local.live_on ? "wss://${var.hostname}/api/live" : null

  apis = toset([
    "artifactregistry.googleapis.com",
    "certificatemanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "compute.googleapis.com",
    "dns.googleapis.com",
    "firestore.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
    "sts.googleapis.com",
  ])
}

resource "google_project_service" "this" {
  for_each = local.apis

  project = var.project_id
  service = each.key
  # Other things in the project may use them.
  disable_on_destroy = false
}

# The images the deploy builds. Only the latest few are kept: a rollback deploys a release again.
resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = local.name
  description   = "${var.name} (${var.env}) images, pushed by ${var.github.owner}/${var.github.repo}."
  format        = "DOCKER"

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s"
    }
  }

  depends_on = [google_project_service.this]
}
