# A minimal root module deploying one Fling instance with platforms/azure/infra, at
# https://fling.example.test with sites at https://<name>.fling.example.test. Copy it into your own
# Terraform repository and replace every example value. See platforms/azure/DEPLOY.md.

terraform {
  # Write-only attributes (the generated secrets never reach state) need 1.11.
  required_version = ">= 1.11"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.81, < 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  # Keep state somewhere durable and shared, for example:
  # backend "azurerm" {
  #   resource_group_name  = "example-terraform"
  #   storage_account_name = "exampletfstate"
  #   container_name       = "tfstate"
  #   key                  = "fling.tfstate"
  #   use_azuread_auth     = true
  # }
}

provider "azurerm" {
  features {}
  subscription_id = "00000000-0000-0000-0000-000000000000"
  # The storage account has no account keys: reach its data plane with Entra ID.
  storage_use_azuread = true
}

module "fling" {
  # From your own configuration, pin a release of the module (or your fork's):
  #   source = "git::https://github.com/<owner>/fling.git//platforms/azure/infra?ref=infra-azure-v<x.y.z>"
  source = "../.."

  namespace = "example" # resources: example-production-fling-*
  env       = "production"
  location  = "westeurope"
  hostname  = "fling.example.test"

  # An Azure DNS zone you already have. The module adds the hostname, the wildcard and Front Door's
  # validation records to it (and, with mail, the sending domain's).
  dns_zone = {
    name                = "example.test"
    resource_group_name = "example-dns"
  }

  # The repository that deploys, and the GitHub environment its deploy job runs in.
  github = {
    repository  = "example-org/fling"
    environment = "azure"
  }

  # Becomes INSTANCE in the deploy output (platforms/aws/DEPLOY.md, Instance configuration).
  instance = {
    ALLOWED_EMAIL_DOMAINS = "example.test"
    OIDC_ISSUER           = "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0"
    OIDC_CLIENT_ID        = "00000000-0000-0000-0000-000000000000"
    INSTANCE_NAME         = "Example Fling"
  }

  # Email notifications through Communication Services, from mail.fling.example.test
  # (platforms/azure/DEPLOY.md, Email). Without it there is no email.
  # mail = {
  #   from_name = "Example Fling"
  # }
}

output "url" {
  value = module.fling.url
}

output "deploy" {
  description = "The repository variable AZURE_DEPLOY_CONFIG, as JSON."
  value       = module.fling.deploy
}

output "key_vault" {
  value = module.fling.key_vault
}

output "manual_secrets" {
  description = "Key Vault secrets to fill by hand (az keyvault secret set)."
  value       = module.fling.manual_secrets
}
