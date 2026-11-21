terraform {
  # The same floor as the AWS module, so one Terraform runs both.
  required_version = ">= 1.11"

  required_providers {
    # 2.59 has everything used here: App Platform's wildcard domains and edge controls
    # (disable_edge_cache), bucket-scoped Spaces keys (digitalocean_spaces_key with a grant).
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.59"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}
