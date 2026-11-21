# Two user-assigned identities:
# - app: what the app and its jobs can do (AZURE_CLIENT_ID, read by DefaultAzureCredential). Its
#   Cosmos DB container's data, the sites container (and user delegation keys, for download SAS),
#   its Key Vault's secrets (the Container Apps secret references), pulling from the registry, its
#   Web PubSub hub, and with var.mail sending through Communication Services. Nothing else.
# - deploy: what the repository's deploy workflow can do, from GitHub Actions over OIDC (a federated
#   credential for one repository and one GitHub environment, so no Azure secret is kept in
#   GitHub): push images, point the app and the jobs at a new image, start the migrate job, and
#   purge Front Door's cache. Its roles are the Container Apps ones (nothing outside Microsoft.App)
#   on the app, its environment and its jobs, and a purge-only role on the Front Door endpoint, so
#   it can't read the profile's rule set, which holds the origin-verify secret.

resource "azurerm_user_assigned_identity" "app" {
  name                = "${local.name}-app"
  location            = var.location
  resource_group_name = local.resource_group_name
  tags                = local.tags
}

# Cosmos DB's data plane has its own RBAC: the built-in Data Contributor (read and write items,
# run queries and batches), on this account only.
resource "azurerm_cosmosdb_sql_role_assignment" "app" {
  resource_group_name = local.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
  role_definition_id  = "${azurerm_cosmosdb_account.this.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = azurerm_user_assigned_identity.app.principal_id
  scope               = azurerm_cosmosdb_account.this.id
}

# Read and write blobs, and get user delegation keys (generateUserDelegationKey is part of it).
resource "azurerm_role_assignment" "app_blobs" {
  scope                = azurerm_storage_account.this.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "app_secrets" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "app_pull" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "app_live" {
  scope                = azurerm_web_pubsub.this.id
  role_definition_name = "Web PubSub Service Owner"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "app_mail" {
  count = local.mail == null ? 0 : 1

  scope                = azurerm_communication_service.this[0].id
  role_definition_name = "Communication and Email Service Owner"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}

# -----------------------------------------------------------------------------
# The deploy workflow
# -----------------------------------------------------------------------------

resource "azurerm_user_assigned_identity" "deploy" {
  name                = "${local.name}-deploy"
  location            = var.location
  resource_group_name = local.resource_group_name
  tags                = local.tags
}

resource "azurerm_federated_identity_credential" "github" {
  name                      = "github-${var.github.environment}"
  user_assigned_identity_id = azurerm_user_assigned_identity.deploy.id
  issuer                    = "https://token.actions.githubusercontent.com"
  audience                  = ["api://AzureADTokenExchange"]
  subject                   = "repo:${var.github.repository}:environment:${var.github.environment}"
}

resource "azurerm_role_assignment" "deploy_push" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPush"
  principal_id         = azurerm_user_assigned_identity.deploy.principal_id
  principal_type       = "ServicePrincipal"
}

# Update the app and the jobs (a new image), start the migrate job and read its executions. A
# revision joins the environment, so the deploy may also act on that.
resource "azurerm_role_assignment" "deploy_apps" {
  for_each = merge(
    {
      app = {
        scope = azurerm_container_app.app.id
        role  = "Container Apps Contributor"
      }
      environment = {
        scope = azurerm_container_app_environment.this.id
        role  = "Container Apps ManagedEnvironments Contributor"
      }
    },
    {
      for k, j in azurerm_container_app_job.this : "job-${k}" => {
        scope = j.id
        role  = "Container Apps Jobs Contributor"
      }
    },
  )

  scope                = each.value.scope
  role_definition_name = each.value.role
  principal_id         = azurerm_user_assigned_identity.deploy.principal_id
  principal_type       = "ServicePrincipal"
}

# Purge Front Door's cache after a deploy, and nothing else: CDN Profile Contributor (or Reader)
# on the profile could read the rule set, and with it the origin-verify secret.
resource "azurerm_role_definition" "purge" {
  name        = "${local.name} Front Door purge"
  scope       = azurerm_cdn_frontdoor_profile.this.id
  description = "Purge the cache of one Fling instance's Front Door endpoint."

  permissions {
    actions = [
      "Microsoft.Cdn/profiles/read",
      "Microsoft.Cdn/profiles/afdendpoints/read",
      "Microsoft.Cdn/profiles/afdendpoints/purge/action",
    ]
  }

  assignable_scopes = [azurerm_cdn_frontdoor_profile.this.id]
}

resource "azurerm_role_assignment" "deploy_purge" {
  scope              = azurerm_cdn_frontdoor_endpoint.this.id
  role_definition_id = azurerm_role_definition.purge.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.deploy.principal_id
  principal_type     = "ServicePrincipal"
}
