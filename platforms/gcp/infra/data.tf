# The app's data: one Firestore database in Native mode, one collection `items` (the Table,
# platforms/gcp/src/table/firestore.ts). Documents hold `pk`, `s` (the sort key's bytes), `data` (the
# item's other fields as JSON) and, on items that expire, `ttl`.
#
# Pessimistic concurrency: a transaction's reads take locks, which is what the Table's conditional
# writes and transactions rely on. Point-in-time recovery is what a data migration is rehearsed on.

locals {
  collection = "items"
}

resource "google_firestore_database" "this" {
  project     = var.project_id
  name        = local.name
  location_id = local.firestore_location
  type        = "FIRESTORE_NATIVE"

  concurrency_mode                  = "PESSIMISTIC"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  deletion_policy                   = "ABANDON"

  depends_on = [google_project_service.this]
}

# A query is one partition (pk) in sort-key order, either way.
resource "google_firestore_index" "partition" {
  for_each = toset(["ASCENDING", "DESCENDING"])

  project     = var.project_id
  database    = google_firestore_database.this.name
  collection  = local.collection
  query_scope = "COLLECTION"

  fields {
    field_path = "pk"
    order      = "ASCENDING"
  }

  fields {
    field_path = "s"
    order      = each.key
  }
}

# Expired items are deleted by the TTL policy (usually within a day); reads already treat them as
# absent.
resource "google_firestore_field" "ttl" {
  project    = var.project_id
  database   = google_firestore_database.this.name
  collection = local.collection
  field      = "ttl"

  ttl_config {}

  # Not queried: no single-field indexes.
  index_config {}
}

# The item's fields, as JSON: never queried, so not indexed (an index entry would cost a write).
resource "google_firestore_field" "data" {
  project    = var.project_id
  database   = google_firestore_database.this.name
  collection = local.collection
  field      = "data"

  index_config {}
}
