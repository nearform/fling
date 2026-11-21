# A minimal root module deploying one Fling instance with platforms/digitalocean/infra, at
# https://fling.example.test with sites at https://<name>.fling.example.test, in a domain this
# DigitalOcean account manages (example.test). Copy it into your own Terraform repository and
# replace every example value. See platforms/digitalocean/DEPLOY.md.
#
# The provider reads DIGITALOCEAN_TOKEN, and SPACES_ACCESS_KEY_ID / SPACES_SECRET_ACCESS_KEY for
# the bucket, from the environment.

terraform {
  required_version = ">= 1.11"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.59"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  # State holds the instance's secrets (the module's header says why): keep it in an encrypted,
  # private bucket, for example a Spaces bucket of its own:
  # backend "s3" {
  #   bucket                      = "example-terraform-state"
  #   key                         = "fling/terraform.tfstate"
  #   region                      = "us-east-1"
  #   endpoints                   = { s3 = "https://ams3.digitaloceanspaces.com" }
  #   skip_credentials_validation = true
  #   skip_requesting_account_id  = true
  #   skip_metadata_api_check     = true
  #   skip_region_validation      = true
  #   skip_s3_checksum            = true
  #   use_path_style              = false
  #   use_lockfile                = true
  # }
}

provider "digitalocean" {}

module "fling" {
  # From your own configuration, pin a release of the Fling repository (or your fork):
  #   source = "git::https://github.com/<owner>/fling.git//platforms/digitalocean/infra?ref=<tag>"
  source = "../.."

  name          = "fling"
  region        = "ams3"
  app_host      = "fling.example.test"
  sites_domain  = "fling.example.test"
  dns_zone      = "example.test"
  registry_name = "example-registry"
  # The release pushed before the first apply (DEPLOY.md, First deploy).
  image_tag = "0.14.0"

  instance = {
    INSTANCE_NAME         = "Example Fling"
    ALLOWED_EMAIL_DOMAINS = "example.test"
    ADMIN_EMAILS          = "admin@example.test"
    OIDC_ISSUER           = "https://accounts.google.com"
    OIDC_CLIENT_ID        = "example.apps.googleusercontent.com"
  }
  instance_secrets = {
    OIDC_CLIENT_SECRET = var.oidc_client_secret
  }
}

variable "oidc_client_secret" {
  description = "The OIDC client's secret (TF_VAR_oidc_client_secret)."
  type        = string
  sensitive   = true
}

output "deploy" {
  description = "The JSON of this is the DO_DEPLOY_CONFIG repository variable."
  value       = module.fling.deploy
}

output "dns" {
  value = module.fling.dns
}

output "tick_secret" {
  value     = module.fling.tick_secret
  sensitive = true
}
