# Fling on Azure: one Container App runs the Node host (platforms/node, with the Azure adapters),
# which answers the app host and every sites host itself, behind Front Door Standard for TLS, the
# wildcard domain and caching. See ../DEPLOY.md and docs/platforms/azure.md.
#
#   <hostname>, *.<sites_domain>  Front Door Standard (managed certificates, X-Origin-Verify header)
#                                 └─ Container App "app" (the Node host: API, UI, sites host)
#   Cosmos DB for NoSQL (serverless, one container, one partition), Blob Storage (`sites`),
#   Web PubSub (the live rooms, upstream events to the app), Key Vault (secrets, read by the
#   Container Apps platform through Key Vault references), Container Apps jobs (migrate; the
#   minute's notify with mail; the hourly maintain), Log Analytics, a container registry, and
#   Communication Services Email with var.mail.
#
# Who changes what:
# - Terraform owns the shape: every resource, the app's and jobs' configuration and environment,
#   roles, DNS, and which secrets exist.
# - The repository's deploy workflow (.github/workflows/deploy-azure.yml) owns the code: the image
#   in the registry, and which image the app and the jobs run. Terraform starts them on a
#   placeholder image and ignores the image from then on, so a plan after a deploy reads
#   "No changes".
# - The app owns the Cosmos DB items and the blobs.
#
# Resource names are <namespace>-<env>-<name> (e.g. acme-production-fling); names Azure keeps global
# get a random suffix as well (local.global).

data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

locals {
  name         = "${var.namespace}-${var.env}-${var.name}"
  url          = "https://${var.hostname}"
  sites_domain = coalesce(var.sites_domain, var.hostname)

  # Global names: lowercase letters, digits (and hyphens where allowed), within each service's limit.
  compact = replace(local.name, "-", "")
  global = {
    hyphenated = "${trimsuffix(substr(local.name, 0, 30), "-")}-${random_string.suffix.result}"
    storage    = "${substr(local.compact, 0, 18)}${random_string.suffix.result}"
    registry   = "${substr(local.compact, 0, 44)}${random_string.suffix.result}"
    key_vault  = "${trimsuffix(substr(local.name, 0, 17), "-")}-${random_string.suffix.result}"
  }

  resource_group_name = var.resource_group_name == null ? azurerm_resource_group.this[0].name : var.resource_group_name
  resource_group_id = (
    var.resource_group_name == null
    ? azurerm_resource_group.this[0].id
    : "/subscriptions/${data.azurerm_client_config.current.subscription_id}/resourceGroups/${var.resource_group_name}"
  )
  tags = merge({ App = var.name, Environment = var.env }, var.tags)
}

resource "azurerm_resource_group" "this" {
  count = var.resource_group_name == null ? 1 : 0

  name     = local.name
  location = var.location
  tags     = local.tags
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = local.name
  location            = var.location
  resource_group_name = local.resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}

# The images the deploy builds (fling:<commit>). Basic is enough for one repository.
resource "azurerm_container_registry" "this" {
  name                = local.global.registry
  location            = var.location
  resource_group_name = local.resource_group_name
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}
