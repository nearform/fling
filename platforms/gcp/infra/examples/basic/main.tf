# A minimal root module deploying one Fling instance with platforms/gcp/infra, at
# https://fling.example.test with sites at https://<name>.fling.example.test. Copy it into your own
# Terraform repository and replace every example value. See platforms/gcp/DEPLOY.md.

terraform {
  # Write-only attributes (the generated secrets never reach state) need 1.11.
  required_version = ">= 1.11"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 7.0, < 8.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 7.0, < 8.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  # Keep state somewhere durable and shared, for example:
  # backend "gcs" {
  #   bucket = "example-terraform-state"
  #   prefix = "fling"
  # }
}

provider "google" {
  project = "example-project"
  region  = "europe-west1"

  default_labels = { app = "fling" }
}

provider "google-beta" {
  project = "example-project"
  region  = "europe-west1"

  default_labels = { app = "fling" }
}

module "fling" {
  # From your own configuration, pin a release of the module (or your fork's):
  #   source = "git::https://github.com/<owner>/fling.git//platforms/gcp/infra?ref=infra-gcp-v<x.y.z>"
  source = "../.."

  project_id    = "example-project"
  region        = "europe-west1"
  namespace     = "example" # resources: example-production-fling-*
  env           = "production"
  bucket_prefix = "example-test-" # bucket names are global
  hostname      = "fling.example.test"
  # A Cloud DNS zone in the project that holds example.test. Without one, add the dns_records output
  # where your DNS is.
  dns_zone = "example-test"

  # The repository that deploys (gh api repos/<owner>/<repo> --jq '.owner.id, .id').
  github = {
    owner    = "example-org"
    owner_id = "1000001"
    repo     = "fling"
    repo_id  = "2000002"
  }

  # Becomes INSTANCE in the deploy output (platforms/aws/DEPLOY.md, Instance configuration).
  instance = {
    ALLOWED_EMAIL_DOMAINS = "example.test"
    OIDC_ISSUER           = "https://accounts.google.com"
    OIDC_CLIENT_ID        = "1234-abcd.apps.googleusercontent.com"
    INSTANCE_NAME         = "Example Fling"
  }

  # Email notifications, through a transactional provider's SMTP server
  # (platforms/gcp/DEPLOY.md, Email). Without it there is no email.
  # mail = {
  #   from = "fling@mail.fling.example.test"
  #   smtp = { host = "smtp.example.test", user = "apikey" }
  # }
}

output "url" {
  value = module.fling.url
}

output "deploy" {
  description = "The repository variable GCP_DEPLOY_CONFIG, as JSON."
  value       = module.fling.deploy
}

output "manual_secrets" {
  description = "Secrets to fill by hand (gcloud secrets versions add)."
  value       = module.fling.manual_secrets
}

output "dns_records" {
  value = module.fling.dns_records
}
