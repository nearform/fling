# The DigitalOcean Container Registry the deploy workflow pushes the Node host image to
# (<registry>/fling-node:<release>). An account has one registry, so an existing one can be used.

resource "digitalocean_container_registry" "fling" {
  count = var.create_registry ? 1 : 0

  name                   = var.registry_name
  subscription_tier_slug = var.registry_tier
  region                 = var.region
}
