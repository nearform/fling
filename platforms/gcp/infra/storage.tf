# The sites bucket: every version's files, manifests, staged uploads and thumbnails
# (platforms/gcp/src/blobs/gcs.ts). Private: the service reads and writes it as its own service
# account, and clients upload and download through V4 signed URLs. Bucket names are global:
# var.bucket_prefix keeps them unique.

resource "google_storage_bucket" "sites" {
  project  = var.project_id
  name     = "${var.bucket_prefix}${local.name}-sites"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # Holds every published site: never emptied by Terraform.
  force_destroy = false

  # Chunked MCP uploads are staged under uploads/<id>/ for at most an hour; sweep any leftovers.
  lifecycle_rule {
    condition {
      age            = 1
      matches_prefix = ["uploads/"]
    }
    action {
      type = "Delete"
    }
  }

  # Uploads a client started and never finished.
  lifecycle_rule {
    condition {
      age = 1
    }
    action {
      type = "AbortIncompleteMultipartUpload"
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_storage_bucket_iam_member" "service" {
  bucket = google_storage_bucket.sites.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.service.email}"
}
