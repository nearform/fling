# The sites' files: one Blob Storage container, `sites` (platforms/azure/src/blobs/blob.ts).
#
# - Private: no anonymous access, and no account keys (shared_access_key_enabled = false). The app
#   reaches it with its managed identity (iam.tf), and signs downloads with user delegation SAS.
# - Uploads go through the app's own upload route, never a SAS PUT (a SAS can't bind a body), so the
#   account needs no CORS.
# - Chunked MCP uploads stage under uploads/ and are deleted on finish; the lifecycle rule removes
#   any left behind after a day.

resource "azurerm_storage_account" "this" {
  name                = local.global.storage
  location            = var.location
  resource_group_name = local.resource_group_name

  account_kind             = "StorageV2"
  account_tier             = "Standard"
  account_replication_type = "LRS"
  access_tier              = "Hot"

  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true

  tags = local.tags
}

resource "azurerm_storage_container" "sites" {
  name                  = "sites"
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = "private"
}

resource "azurerm_storage_management_policy" "this" {
  storage_account_id = azurerm_storage_account.this.id

  rule {
    name    = "expire-uploads"
    enabled = true

    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["${azurerm_storage_container.sites.name}/uploads/"]
    }

    actions {
      base_blob {
        delete_after_days_since_modification_greater_than = 1
      }
    }
  }
}
