# The app: one Container App running the Node host (platforms/azure/src/main.ts), reached through
# Front Door only, and three Container Apps jobs on the same image, identity, environment and
# secrets, each running its work in its own process:
# - migrate (started by the deploy): `node main.mjs migrate`, the data migrations until done;
# - maintain (hourly): `node main.mjs tick maintain`;
# - notify (every minute, with var.mail only): `node main.mjs tick notify`, the notifications drain.
#
# Ingress is external, because Front Door Standard reaches origins over the internet. The app
# refuses a request without the X-Origin-Verify header Front Door adds (ORIGIN_VERIFY_SECRET).
# Front Door sends the Container App's own hostname as Host, which Container Apps routes by, and
# its rule writes the visitor's as X-Fling-Host, which the app routes by (edge.tf).
#
# Until the first deploy the app and the jobs run a placeholder image. The deploy workflow points
# them at the image it pushed (az containerapp update --image), and Terraform ignores the image
# from then on.

locals {
  placeholder_image = "mcr.microsoft.com/k8se/quickstart:latest"

  # The plumbing, from the module's inputs. The instance's own values (ALLOWED_EMAIL_DOMAINS,
  # OIDC_*, INSTANCE_NAME, BRAND_*) travel in the deploy config's INSTANCE object instead
  # (var.instance, built into the image as instance.json), so changing them needs no apply;
  # var.environment can still set or override any key here except those the module owns.
  environment = merge(
    {
      APP_ORIGIN         = local.url
      SITES_DOMAIN       = local.sites_domain
      SITE_SCHEME        = "https"
      SITE_COOKIE_DOMAIN = ".${local.sites_domain}"
      LIVE_URL           = local.live_url
    },
    var.environment,
    {
      APP_ENV             = "production"
      PORT                = "8080"
      STORE_DRIVER        = "cosmos"
      STORAGE_DRIVER      = "azure-blob"
      KVS_DRIVER          = "table"
      AZURE_CLIENT_ID     = azurerm_user_assigned_identity.app.client_id
      COSMOS_ENDPOINT     = azurerm_cosmosdb_account.this.endpoint
      COSMOS_DATABASE     = azurerm_cosmosdb_sql_database.this.name
      COSMOS_CONTAINER    = azurerm_cosmosdb_sql_container.items.name
      BLOB_ENDPOINT       = azurerm_storage_account.this.primary_blob_endpoint
      SITES_CONTAINER     = azurerm_storage_container.sites.name
      WEB_PUBSUB_ENDPOINT = "https://${azurerm_web_pubsub.this.hostname}"
      WEB_PUBSUB_HUB      = local.web_pubsub_hub
    },
    local.mail_environment,
  )

  # Container Apps secret names: lowercase letters, digits and hyphens, as the Key Vault names are.
  secrets = {
    for name in concat(
      var.generated_secrets,
      var.manual_secrets,
      ["origin-verify-secret", "live-events-secret"],
    ) : name => local.secret_ids[name]
  }

  # The jobs: what each runs, and when.
  jobs = merge(
    {
      migrate = {
        command  = ["node", "main.mjs", "migrate"]
        schedule = null
        timeout  = 1800
      }
      maintain = {
        command  = ["node", "main.mjs", "tick", "maintain"]
        schedule = "17 * * * *"
        timeout  = 900
      }
    },
    local.mail == null ? {} : {
      notify = {
        command  = ["node", "main.mjs", "tick", "notify"]
        schedule = "* * * * *"
        timeout  = 120
      }
    },
  )
}

resource "azurerm_container_app_environment" "this" {
  name                       = local.name
  location                   = var.location
  resource_group_name        = local.resource_group_name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.this.id
  tags                       = local.tags
}

resource "azurerm_container_app" "app" {
  name                         = "${trimsuffix(substr(local.name, 0, 28), "-")}-app"
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = local.resource_group_name
  revision_mode                = "Single"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.this.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = local.secrets
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  ingress {
    external_enabled           = true
    target_port                = 8080
    transport                  = "auto"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.container.min_replicas
    max_replicas = var.container.max_replicas

    container {
      name   = "app"
      image  = local.placeholder_image
      cpu    = var.container.cpu
      memory = var.container.memory

      dynamic "env" {
        for_each = local.environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secrets
        content {
          name        = local.secret_env[env.key]
          secret_name = env.key
        }
      }
    }

    http_scale_rule {
      name                = "http"
      concurrent_requests = "50"
    }
  }

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [
    azurerm_role_assignment.app_secrets,
    azurerm_role_assignment.app_pull,
  ]
}

resource "azurerm_container_app_job" "this" {
  for_each = local.jobs

  name                         = "${trimsuffix(substr(local.name, 0, 23), "-")}-${each.key}"
  location                     = var.location
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = local.resource_group_name
  replica_timeout_in_seconds   = each.value.timeout
  replica_retry_limit          = 0
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.this.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  dynamic "secret" {
    for_each = local.secrets
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = azurerm_user_assigned_identity.app.id
    }
  }

  dynamic "manual_trigger_config" {
    for_each = each.value.schedule == null ? [1] : []
    content {
      parallelism              = 1
      replica_completion_count = 1
    }
  }

  dynamic "schedule_trigger_config" {
    for_each = each.value.schedule == null ? [] : [each.value.schedule]
    content {
      cron_expression          = schedule_trigger_config.value
      parallelism              = 1
      replica_completion_count = 1
    }
  }

  template {
    container {
      name    = each.key
      image   = local.placeholder_image
      command = each.value.command
      cpu     = var.container.cpu
      memory  = var.container.memory

      dynamic "env" {
        for_each = local.environment
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.secrets
        content {
          name        = local.secret_env[env.key]
          secret_name = env.key
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].container[0].image]
  }

  depends_on = [
    azurerm_role_assignment.app_secrets,
    azurerm_role_assignment.app_pull,
  ]
}
