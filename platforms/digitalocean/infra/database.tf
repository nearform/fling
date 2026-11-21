# The Table: Managed PostgreSQL, one database and one user for the Node host. Only the app may
# connect (the firewall), over TLS checked against the cluster's own CA.

resource "digitalocean_database_cluster" "fling" {
  name       = "${var.name}-db"
  engine     = "pg"
  version    = var.postgres_version
  size       = var.database_size
  region     = var.region
  node_count = var.database_node_count
}

resource "digitalocean_database_db" "fling" {
  cluster_id = digitalocean_database_cluster.fling.id
  name       = "fling"
}

resource "digitalocean_database_user" "fling" {
  cluster_id = digitalocean_database_cluster.fling.id
  name       = "fling"
}

data "digitalocean_database_ca" "fling" {
  cluster_id = digitalocean_database_cluster.fling.id
}

# Trusted sources: the app alone. It is added once the app exists, so the app's first deploy
# connects while the cluster still takes any source (over TLS, with the user's password).
resource "digitalocean_database_firewall" "fling" {
  cluster_id = digitalocean_database_cluster.fling.id

  rule {
    type  = "app"
    value = digitalocean_app.fling.id
  }
}
