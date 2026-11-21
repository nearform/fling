output "url" {
  description = "Where the app is served."
  value       = local.url
}

output "deploy" {
  description = <<-EOT
    What the deploy workflow needs, set as ONE repository variable, GCP_DEPLOY_CONFIG, holding this
    map as JSON: terraform output -json deploy | gh variable set GCP_DEPLOY_CONFIG -R <owner>/<repo>.
    Includes INSTANCE when var.instance is set. Nothing here is secret.
  EOT
  value = merge(
    {
      GCP_PROJECT                    = var.project_id
      GCP_REGION                     = var.region
      GCP_WORKLOAD_IDENTITY_PROVIDER = google_iam_workload_identity_pool_provider.github.name
      GCP_DEPLOY_SERVICE_ACCOUNT     = google_service_account.deploy.email
      SERVICE                        = google_cloud_run_v2_service.api.name
      IMAGE_REPOSITORY               = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
      APP_ORIGIN                     = local.url
    },
    # Only when set, so an empty var.instance leaves the output as it was.
    { for k, v in { INSTANCE = var.instance } : k => v if length(v) > 0 },
  )
}

output "dns_records" {
  description = <<-EOT
    The records the instance needs: the hostname and the wildcard at the load balancer, and the
    certificate's DNS authorisation. With var.dns_zone the module made them; without it, add them
    where the domain's DNS is.
  EOT
  value       = [for k, r in local.dns_records : r]
}

output "load_balancer_ips" {
  description = "The load balancer's addresses."
  value = {
    ipv4 = google_compute_global_address.ipv4.address
    ipv6 = google_compute_global_address.ipv6.address
  }
}

output "live_url" {
  description = "Where review pages open their live room's WebSocket (the service's LIVE_URL); null with live rooms off."
  value       = local.live_url
}

output "manual_secrets" {
  description = "Secrets that someone has to fill (gcloud secrets versions add <secret> --data-file=-)."
  value       = [for s in local.manual_secrets : google_secret_manager_secret.this[s].secret_id]
}

output "firestore_database" {
  description = "The Firestore database (the Table is its `items` collection)."
  value       = google_firestore_database.this.name
}

output "sites_bucket" {
  description = "The sites bucket."
  value       = google_storage_bucket.sites.name
}

output "service" {
  description = "The Cloud Run service."
  value       = google_cloud_run_v2_service.api.name
}

output "service_account" {
  description = "The service's own service account."
  value       = google_service_account.service.email
}

output "tick_jobs" {
  description = "The Cloud Scheduler jobs: maintain, and notify with var.mail."
  value       = { for k, j in google_cloud_scheduler_job.tick : k => j.name }
}
