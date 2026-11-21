<!-- markdownlint-disable MD013 -->

# Platform: Azure

How Fling would meet the [logical platform](../design/platform.md) on Azure. There is no deploy
guide yet.

## 1. Status and shape

**Status:** proposed. No code exists. This document is the design to build from.

**Shape:** one host that routes. The [shared Node host](../design/platform.md#5-shared-building-blocks-for-new-platforms)
runs as one Container App that answers the app host and the sites host. Front Door Standard sits
in front for TLS, the wildcard domain and caching. Front Door's rules engine has no compute, so
the routing decision runs in the Container App, as it does in the Cloudflare Worker.

**Cost floor (idle):** roughly $40–45 a month.
- Front Door Standard has a base fee of about $35 a month.
- Container Apps scale to zero.
- Cosmos DB serverless, Blob Storage, Key Vault and Web PubSub's free tier cost little at idle.
- Postgres Flexible (the fallback) adds about $13 a month at B1ms.

**Effort:** large.
- Three new adapters: Cosmos DB, Blob Storage and Web PubSub.
- An Azure Communication Services mailer.
- The shared Node host.
- A Terraform module.
- A deploy workflow.
- Site servers on dynamic sessions.

## 2. Mapping

| Element | Azure service | Adapter | Notes |
|---|---|---|---|
| Table | Cosmos DB for NoSQL, serverless, one container, **one constant partition key** | `platforms/azure/src/table/cosmos.ts` | See "Table on Cosmos DB" below. Fallback: Postgres Flexible Server with the shared Postgres adapter |
| Blobs | Blob Storage (`sites` container), SAS URLs | `platforms/azure/src/blobs/blob.ts` | Put Blob checks Content-MD5 or CRC64, never SHA-256 ([known gap](../design/platform.md#6-known-gaps-in-the-contract)). Until the contract changes, uploads go through the host's signed routes. `copy` is server-side (Copy Blob) |
| Route table | Cosmos DB, behind an in-process cache | `platforms/azure/src/route-table/cached.ts` over the core's `TableRouteTable` | The Cloudflare `CachedRouteTable` pattern |
| Sites host | Container Apps (the Node host) behind Front Door Standard | `platforms/node` (shared) | See §3 |
| Live hub | Azure Web PubSub, one group per site | `platforms/azure/src/live.ts` | The closest match to the API Gateway WebSocket API. The service keeps the connections, and connect, message and disconnect events reach the host as upstream webhooks. `publish` is a REST send to the site's group, and connections are live connection records, as on AWS |
| Mailer | Azure Communication Services Email | `platforms/azure/src/mail/acs.ts` | A verified domain for `mail.<sites domain>`. Throttling and suppression map to the core's reasons |
| Site servers | Container Apps dynamic sessions with custom containers, one session pool for servers | `platforms/azure/src/servers/` | See "Site servers" below |
| Server logs | Log Analytics (query API) | `platforms/azure/src/servers/server-logs.ts` | Read-only; sessions' stdout is collected by the environment |
| Ticks | Container Apps jobs with a cron trigger | `platforms/azure/src/entry.ts` | `notify` every minute (with mail), `maintain` hourly. The job runs the same image |
| Migrations | a Container Apps job, started by the deploy | `platforms/azure/src/migrate.ts` | Loops until done |
| Secrets | Key Vault, read through the host's managed identity | `platforms/azure/src/secrets.ts` | Generated secrets are set outside Terraform, so they stay out of state |
| Sign-in | (core OIDC) | — | Entra ID is one documented issuer. The client secrets are in Key Vault |

### Table on Cosmos DB

- **Why one partition key:** Cosmos DB has no transactions across logical partitions. A
  transactional batch, like a stored procedure, stays within one partition key, and the Table's
  `transact` spans several pks. Giving every item the same partition key value puts the whole
  table in one logical partition, so every `transact` fits in one batch.
- **Limits that come with it:**
  - One logical partition holds at most 20 GB. D1, the Cloudflare Table, holds at most 10 GB.
  - Throughput is capped at 10,000 RU/s.
  - A transactional batch carries at most 100 operations and 2 MB, and runs in at most 5 seconds.
    `TRANSACT_MAX` is 25.
- **Layout:** each item is a document with these fields:
  - `id`: a hash of `pk` and `sk`, because `id` may not contain `/`, `\`, `?` or `#`;
  - `pk`, `sk` and `data`;
  - `skx`: the hex-encoded UTF-8 bytes of `sk`;
  - `ttl`.

  `query` filters on `pk` and orders and ranges on `skx`. The hex form sorts in byte order under
  any string comparison, whereas Cosmos DB's ORDER BY collation for strings is not documented.
  A prefix becomes the hex range `[hex(prefix), hex(prefix) + 'g')`.
- **Conditions:**
  - `ifAbsent` is a create.
  - `ifExists` and `fieldEquals` read the item and then replace or delete it with its ETag
    (`IfMatch`), all inside the batch.
  - A precondition failure (412 or 409) maps to `ConditionFailed` with the op index.
  - `add` is a patch `incr` operation.
- **Expiry:** container TTL is on, and each item's `ttl` is set from `expiresAt`. Reads and
  conditions also treat an item past its `expiresAt` as absent.
- **Consistency:** strong consistency is assured by staying in one region with session
  consistency read through one client, or the account is set to Strong. The races suite decides
  which.
- **Fallback:** if a limit bites, the Table moves to Postgres Flexible Server with the
  [shared Postgres adapter](../design/platform.md#5-shared-building-blocks-for-new-platforms).
  Its transactions are real across items. The data moves with the migrations runner's scan.

### Site servers

- **What runs:** Container Apps dynamic sessions with custom containers (GA since November
  2024). Each session is a Hyper-V-isolated sandbox from a pool that keeps some warm. The pool
  runs a generic runner image that holds the core's shell. A session per site version (session
  identifier `site:<siteId>:<versionId>:<run>`, as on Cloudflare) loads the version's
  `_fling/server.mjs` from Blob Storage.
- **Versions:** the route value's `t` names the session, so the route is the switch and there is
  no `goLive`.
- **Isolation:**
  - The pool's management endpoint is reachable only with the host's managed identity.
  - Sessions get no identity of their own.
  - Egress `none` is the pool's network setting with egress off; `open` lets it out.
- **Alternative:** one Container App per site with revisions, if sessions' lifetime or cold
  starts don't fit. It isolates less (no Hyper-V boundary) and costs more to keep warm.

## 3. Edge and sites host

The Node host runs `routeSiteRequest` for every request to `*.<sites domain>`:
- A rewrite streams the blob, adds the decision's headers, and marks only public sites cacheable.
- A response is returned directly.
- An invoke goes to the site's session with the viewer and site headers.

Front Door caches what is marked public. Its rules engine can rewrite URLs and set headers, but it
cannot read a key-value store or check an HMAC, so it cannot run the decision.

## 4. Domains and TLS

- Front Door Standard has two custom domains: the hostname and `*.hostname`. Since June 2025, a
  Front Door managed certificate covers a wildcard domain. A Key Vault certificate is the
  alternative.
- Azure DNS holds the zone, the validation TXT records, and CNAME or alias records pointing at
  the Front Door endpoint.
- The Container App accepts only Front Door traffic: an IP restriction to the `AzureFrontDoor.Backend`
  service tag, plus a check of the `X-Azure-FDID` header against the profile's ID (the role
  `ORIGIN_VERIFY_SECRET` plays on AWS).

## 5. Infrastructure as code

Proposed as a Terraform module at `platforms/azure/infra` on the `azurerm` provider (and `azapi`
where `azurerm` lags), versioned by `infra-azure-v<x.y.z>` tags. Ownership is split as on AWS.

| File | Resources |
|---|---|
| `main.tf` | `azurerm_resource_group`; `azurerm_log_analytics_workspace`; `azurerm_container_registry` |
| `api.tf` | `azurerm_container_app_environment`; `azurerm_container_app` (the Node host, placeholder image, `ignore_changes`); `azurerm_container_app_job` for migrate and the cron ticks (`notify` with mail, `maintain`) |
| `edge.tf` | `azurerm_cdn_frontdoor_profile` (Standard); `_endpoint`; `_origin_group`; `_origin`; `_route`; `azurerm_cdn_frontdoor_custom_domain` for the hostname and wildcard, with managed certificates; `_custom_domain_association` |
| `dns.tf` | `azurerm_dns_txt_record` for validation; `azurerm_dns_cname_record` for the hostname and wildcard (the zone is looked up) |
| `data.tf` | `azurerm_cosmosdb_account` (serverless, one region); `azurerm_cosmosdb_sql_database`; `azurerm_cosmosdb_sql_container` (partition key `/p`, `default_ttl = -1`, index on `pk` and `skx`). Fallback: `azurerm_postgresql_flexible_server` and its database |
| `storage.tf` | `azurerm_storage_account`; `azurerm_storage_container` for `ui` and `sites`; `azurerm_storage_management_policy` (expire `uploads/`) |
| `secrets.tf` | `azurerm_key_vault` (RBAC); role assignments (values set outside Terraform) |
| `live.tf` | `azurerm_web_pubsub`; `azurerm_web_pubsub_hub` with event handlers to the host |
| `mail.tf` (with mail) | `azurerm_communication_service`; `azurerm_email_communication_service`; `azurerm_email_communication_service_domain`; its DNS records |
| `iam.tf` | `azurerm_user_assigned_identity` for the host and deploy; `azurerm_federated_identity_credential` for GitHub OIDC (repository and environment subject); role assignments |
| `servers.tf` (with servers) | A session pool (`azapi_resource`, `Microsoft.App/sessionPools`, custom container); a zips container; with egress `none`, `azurerm_virtual_network` and subnet for the environment with outbound denied |

Tests run as `terraform test` with mocked providers.

## 6. Deploy and local runtime

- **Deploy:** a `deploy-azure.yml` workflow signs in with the federated credential. In order, it:
  1. builds the image and pushes it to ACR;
  2. updates the Container App and jobs;
  3. starts the migrate job until done;
  4. polls `/.well-known/fling`;
  5. syncs the UI and the sites' own pages to Blob Storage;
  6. purges Front Door for the app host;
  7. runs the e2e smoke test.
- **Local runtime:** the Node host over the Cosmos DB Linux emulator (vNext) and Azurite, added
  to `packages/e2e/src/local.ts`.
- **Emulators in CI:** Azurite and the Cosmos DB emulator as service containers. Web PubSub has
  no emulator; its local tool proxies to a real service, so the hub is tested with a fake.

## 7. Capabilities

- At first, everything except `servers` and `serversEgress`.
- `live` is on with Web PubSub.
- `email` and `invites` are on with Communication Services.
- `servers` turns on with dynamic sessions. `serversEgress` follows the egress setting.

## 8. Gaps and open questions

- **SHA-256 upload binding:** Put Blob validates only Content-MD5 or CRC64 (CRC64-NVME), so the
  [contract change](../design/platform.md#6-known-gaps-in-the-contract) decides whether uploads
  can go direct.
- **Cosmos DB string order:** the ORDER BY documentation does not state the collation for
  strings, so the adapter orders on the hex `skx`. Test the native `sk` order against the
  conformance suite and drop `skx` if it matches.
- **Strong consistency in serverless:** confirm that a single-region serverless account with
  Strong (or session reads through one client) passes the races suite.
- **The 20 GB partition:** this is the ceiling for an instance. Measure a real instance's table
  size before committing. Postgres is the escape.
- **The batch limit of 100 operations** comes from secondary sources. Confirm it against the
  service quotas. It is above `TRANSACT_MAX` either way.
- **Dynamic sessions:** some Learn pages still say Preview, against the November 2024 GA
  announcement. Confirm before relying on them. Also confirm the session lifetime and cold start
  for a server's first request, and whether a session's egress can be set per pool.
- **Front Door wildcard managed certificates** are announced GA (June 2025), but older Learn
  pages still say no. Confirm in the portal. The alternative is a Key Vault certificate.

## 9. Sources

- [Cosmos DB transactional batch](https://learn.microsoft.com/azure/cosmos-db/transactional-batch)
- [Cosmos DB partitioning](https://learn.microsoft.com/azure/cosmos-db/partitioning-overview)
- [Cosmos DB ORDER BY](https://learn.microsoft.com/azure/cosmos-db/nosql/query/order-by)
- [Put Blob](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob)
- [Front Door wildcard domains](https://learn.microsoft.com/azure/frontdoor/front-door-wildcard-domain)
- [Front Door managed certificates for wildcard domains, GA](https://mc.merill.net/message/AZ496631)
- [Front Door rules engine](https://learn.microsoft.com/azure/frontdoor/front-door-rules-engine)
- [Container Apps dynamic sessions](https://learn.microsoft.com/azure/container-apps/sessions)
- [Custom container sessions](https://learn.microsoft.com/azure/container-apps/sessions-custom-container)
- [Dynamic sessions GA](https://mc.merill.net/message/AZ467838)
