# Live rooms (review mode's realtime): Azure Web PubSub keeps the WebSocket connections, one hub,
# `fling`. Clients connect to LIVE_URL (the hub's client endpoint) with the core's live ticket in
# the query string; anonymous connections are allowed because the app's connect handler is the
# check: Web PubSub sends the connect event to the app (platforms/azure/src/live.ts), which admits
# the ticket or refuses the connection.
#
# Connect, messages and disconnect reach the app as CloudEvents over HTTPS, through Front Door
# (so they carry X-Origin-Verify) at /webpubsub/events, with ?code=<live-events-secret>: the app
# refuses an event without it. The app sends to connections and groups with its managed identity
# (Web PubSub Service Owner, iam.tf). The instance turns live rooms off with LIVE=false.

locals {
  web_pubsub_hub = "fling"
  live_url       = "wss://${azurerm_web_pubsub.this.hostname}/client/hubs/${local.web_pubsub_hub}"
}

resource "azurerm_web_pubsub" "this" {
  name                = local.global.hyphenated
  location            = var.location
  resource_group_name = local.resource_group_name
  sku                 = var.web_pubsub_sku
  capacity            = 1

  # Only Entra ID (the app's identity) on the management side; no access keys.
  local_auth_enabled = false
  aad_auth_enabled   = true

  tags = local.tags
}

resource "azurerm_web_pubsub_hub" "fling" {
  name          = local.web_pubsub_hub
  web_pubsub_id = azurerm_web_pubsub.this.id

  anonymous_connections_enabled = true

  event_handler {
    url_template       = "${local.url}/webpubsub/events?code=${random_password.live_events.result}"
    user_event_pattern = "*"
    system_events      = ["connect", "connected", "disconnected"]
  }
}
