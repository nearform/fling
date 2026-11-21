# The app's data: one Cosmos DB for NoSQL container, every item in one logical partition
# (platforms/azure/src/table/cosmos.ts), on a serverless account in one region.
#
# - One partition, because Cosmos DB's transactional batches stay inside one partition key and the
#   Table's transactions span several pks. Its cap is the instance's: 20 GB and 10,000 RU/s.
# - Strong consistency, so a read by any replica of the app sees every committed write (the races
#   the Table's conditions exist for). One region keeps that cheap.
# - default_ttl -1: TTL is on, and only items that carry a `ttl` (from expiresAt) expire.
# - The items' fields are JSON text in `j`, never queried, so they are left out of the index; the
#   composite index serves query's `pk =` with `ORDER BY skx`.
# - Only Entra ID (the app's managed identity, iam.tf) reaches the data: keys are off.

resource "azurerm_cosmosdb_account" "this" {
  name                = local.global.hyphenated
  location            = var.location
  resource_group_name = local.resource_group_name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Strong"
  }

  geo_location {
    location          = var.location
    failover_priority = 0
  }

  local_authentication_enabled = false
  minimal_tls_version          = "Tls12"

  backup {
    type = "Continuous"
    tier = "Continuous7Days"
  }

  tags = local.tags
}

resource "azurerm_cosmosdb_sql_database" "this" {
  name                = var.name
  resource_group_name = local.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
}

resource "azurerm_cosmosdb_sql_container" "items" {
  name                = "items"
  resource_group_name = local.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
  database_name       = azurerm_cosmosdb_sql_database.this.name

  partition_key_paths   = ["/p"]
  partition_key_version = 2
  default_ttl           = -1

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

    excluded_path {
      path = "/j/?"
    }

    excluded_path {
      path = "/\"_etag\"/?"
    }

    composite_index {
      index {
        path  = "/pk"
        order = "Ascending"
      }
      index {
        path  = "/skx"
        order = "Ascending"
      }
    }

    composite_index {
      index {
        path  = "/pk"
        order = "Ascending"
      }
      index {
        path  = "/skx"
        order = "Descending"
      }
    }
  }
}
