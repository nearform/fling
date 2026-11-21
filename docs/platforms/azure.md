<!-- markdownlint-disable MD013 -->

# Platform: Azure

How Fling meets the [logical platform](../design/platform.md) on Azure. The deploy guide is
[platforms/azure/DEPLOY.md](../../platforms/azure/DEPLOY.md).

## 1. Status and shape

**Status:** supported. `platforms/azure` (`@fling/platform-azure`) holds the entry point, the
adapters, the container image and the Terraform module (`platforms/azure/infra`). Site servers
are not built yet (§7).

**Shape:** one host that routes. The [shared Node host](../design/platform.md#5-shared-building-blocks-for-new-platforms)
runs as one Container App that answers the app host and the sites host. Front Door Standard sits
in front for TLS, the wildcard domain and caching. Front Door's rules engine has no compute, so
the routing decision runs in the Container App, as it does in the Cloudflare Worker.

**Cost floor (idle):** roughly $40–45 a month.
- Front Door Standard has a base fee of about $35 a month.
- The Container App scales to zero, and the jobs are billed for the seconds they run.
- Cosmos DB serverless, Blob Storage, Key Vault, the Container Registry (Basic, about $5) and
  Web PubSub's free tier cost little at idle.

## 2. Mapping

| Element | Azure service | Adapter | Notes |
|---|---|---|---|
| Table | Cosmos DB for NoSQL, serverless, one container, **one constant partition key** | `platforms/azure/src/table/cosmos.ts` (`CosmosTable`) | See "Table on Cosmos DB" below |
| Blobs | Blob Storage (`sites` container) | `platforms/azure/src/blobs/blob.ts` (`AzureBlobs`) | Uploads go through the host's upload routes (`HostUploads`), because a SAS binds no header (see "Blobs" below). Downloads are user delegation SAS URLs. `copy` is server-side (Copy Blob) |
| Route table | Cosmos DB, behind an in-process cache | the shared `CachedRouteTable` (`platforms/node/src/route-table/cached.ts`) over the core's `TableRouteTable` | A changed route reaches every replica within 5 s |
| Sites host | Container Apps (the Node host) behind Front Door Standard | `platforms/node/src/host.ts`, wrapped by `platforms/azure/src/host.ts` | See §3 |
| Live hub | Azure Web PubSub, one group per site | `platforms/azure/src/live.ts` (`WebPubSubLiveHub`) | See "Live rooms" below |
| Mailer | Azure Communication Services Email | `platforms/azure/src/mail/acs.ts` (`AcsMailer`, `MAIL_DRIVER=acs`) | A verified domain, `mail.<sites domain>` by default. The sender's display name is the sender username's (the Terraform `mail.from_name`): ACS takes none per message |
| Site servers | — | — | Not built: `SERVERS` stays off (§7) |
| Ticks | Container Apps jobs with a cron trigger | `platforms/azure/src/main.ts` (`tick notify`, `tick maintain`) | `notify` every minute (with mail), `maintain` hourly. Each job runs the tick in its own process with the same image and identity, so no endpoint can start one |
| Migrations | a Container Apps job, started by the deploy | `platforms/azure/src/main.ts` (`migrate`) | Runs until the runner reports done, then exits; a failure fails the execution |
| Secrets | Key Vault, as Container Apps secret references | `platforms/azure/infra/secrets.tf` | Container Apps resolves them with the host's identity into environment variables, so nothing reads Key Vault at start |
| Sign-in | (core OIDC) | — | Entra ID is one OIDC issuer. The client secrets are in Key Vault |

Every Azure service is reached with the host's user-assigned managed identity
(`DefaultAzureCredential`, `AZURE_CLIENT_ID`): no service key is in the app's configuration. The
services' locations are in `platforms/azure/src/settings.ts` (`COSMOS_ENDPOINT`, `BLOB_ENDPOINT`,
`WEB_PUBSUB_ENDPOINT`, `ACS_ENDPOINT` and their containers and hub), set by Terraform.

### Table on Cosmos DB

- **Why one partition key:** Cosmos DB has no transactions across logical partitions. A
  transactional batch stays within one partition key, and the Table's `transact` spans several
  pks. Every item has the same partition key value (`/p` is `fling`), so the whole table is one
  logical partition and every write is one batch.
- **Limits that come with it:**
  - One logical partition holds at most 20 GB, the ceiling of an instance. D1, the Cloudflare
    Table, holds at most 10 GB. The fallback is the shared Postgres Table on Azure Database for
    PostgreSQL Flexible Server; the data moves with the migrations runner's scan.
  - Throughput is capped at 10,000 RU/s.
  - A transactional batch carries at most 100 operations and 2 MB, above `TRANSACT_MAX` (25).
- **Layout:** each item is a document with these fields:
  - `id`: the hex SHA-256 of `pk` and `sk` (an id may not hold `/`, `\`, `?` or `#`, and hex
    sorts the same under any collation, which the scan's paging relies on);
  - `pk`, `sk`;
  - `skx`: the hex-encoded UTF-8 bytes of `sk`;
  - `j`: the item's other fields as JSON text, because Cosmos DB refuses a document holding a
    lone surrogate, which items may. The indexing policy leaves `/j` out;
  - `x` (expiresAt in epoch ms) and `ttl`.

  `query` filters on `pk` and orders and ranges on `skx`, so the order is `sk`'s byte order
  whatever collation Cosmos DB compares strings with. A prefix is the range
  `[hex(prefix), hex(prefix) + 'g')`, and a cursor is `skx > hex(sk)`. Pages use `TOP`, never
  Cosmos DB's continuation tokens.
- **Writes:** every write reads the items it touches, checks its conditions on them in JS, and
  commits one transactional batch bound to what it read: a Replace or Delete with the read
  document's ETag (`ifMatch`), a Create where there was none, an Upsert for a put without a
  condition. If another writer got in between, the batch fails whole (412 or 409) and the write
  starts again from its reads. So of N racing writers exactly one wins, and concurrent `add`s all
  count. A delete whose condition holds because there is no item creates a dead placeholder in
  the batch, so a concurrent create fails one of the two.
- **Expiry:** container TTL is on (`default_ttl = -1`), and each item's `ttl` is set from
  `expiresAt` (at most 68 years, Cosmos DB's limit). Reads and conditions treat an item past `x`
  as absent, since the purge lags.
- **Consistency:** the account is single-region with Strong consistency, so a read by any replica
  of the host sees every committed write. The races suite passes on the emulator.

### Blobs

A SAS signs its URL (permissions, blob, times) and no request header, so a SAS PUT can't be
bound to a body: Put Blob checks a `Content-MD5` the client sends, but takes a body without one,
and any Content-Type (`platforms/azure/tests/blobs.test.ts` shows both on Azurite). So
`presignPut` signs the host's upload route (`HostUploads`) for every file: the host checks the
SHA-256 itself and writes the bytes. Every upload passes through Front Door and the Container
App, within its 32 MiB request limit (above `MAX_FILE_BYTES`, 25 MiB). The store's
`uploadDigest` is `sha256`, so publication needs no staging copy.

`presignGet` is a read-only user delegation SAS for one blob, signed with a key the service gives
the host's identity and kept for an hour.

### Live rooms

Web PubSub holds the sockets, as API Gateway does on AWS, and the room is the site's live
connection records in the Store.
- `LIVE_URL` is `wss://<service>/client/hubs/fling`. The hub allows anonymous connects, so the
  web client opens `LIVE_URL?ticket=…` as on every platform.
- The hub's event handler posts CloudEvents to `https://<hostname>/webpubsub/events?code=<secret>`
  on the app host, through Front Door. The host answers the abuse-protection handshake for its own
  service only, and refuses any event without the live-events secret (`LIVE_EVENTS_SECRET`) or
  for another hub.
- `connect` admits the core's ticket from the client's query, stores the connection, puts it in
  the site's group and tells the room `join`. A refusal is a 401, which closes the socket.
- A client message is a user event, relayed by the core; the answer is always empty, and replies
  go out through the service's REST API. `disconnected` forgets the connection and tells the room
  `leave`.
- `publish` is one send to the site's group. A send to one connection the service reports gone
  forgets it.

## 3. Edge and sites host

The Node host runs `routeSiteRequest` for every request to `*.<sites domain>`:
- A rewrite reads the blob, adds the decision's headers, and marks only public sites cacheable.
- A response is returned directly.

Front Door caches what is marked public. Its rules engine can rewrite URLs and set headers, but it
cannot read a key-value store or check an HMAC, so it cannot run the decision.

Front Door sends the Container App's own name as the Host, since Container Apps routes by it, and
the name the visitor asked for as `X-Forwarded-Host`. A rule adds `X-Origin-Verify` with the
origin-verify secret on the way to the origin (the role `ORIGIN_VERIFY_SECRET` plays on AWS). The
Container App answers 403 to a request without it, and otherwise routes by `X-Forwarded-Host`
(`platforms/azure/src/front-door.ts`).

## 4. Domains and TLS

- Front Door Standard has two custom domains, the hostname and `*.<sites domain>`, each with a
  Front Door managed certificate.
- Azure DNS, when the module is given the zone, holds the `_dnsauth` validation TXT records and
  the CNAME records pointing at the Front Door endpoint. Without a zone, the module's outputs list
  the records to create.

## 5. Infrastructure as code

A Terraform module at `platforms/azure/infra` on the `azurerm` provider, versioned by
`infra-azure-v<x.y.z>` tags. Ownership is split as on AWS: Terraform owns the shape, and the deploy
owns the code (the image).

| File | Resources |
|---|---|
| `main.tf` | the resource group (or an existing one); Log Analytics; the Container Registry |
| `api.tf` | the Container Apps environment; the Container App (the Node host; the image is the deploy's); the jobs for `migrate`, `notify` (with mail) and `maintain` |
| `edge.tf` | the Front Door Standard profile, endpoint, origin group, origin and route; the custom domains for the hostname and the wildcard with managed certificates; the rule set adding `X-Origin-Verify` |
| `dns.tf` | with a zone: the validation TXT records and the CNAME records |
| `data.tf` | the Cosmos DB account (serverless, one region, Strong); its database and container (partition key `/p`, TTL on, `/j` not indexed) |
| `storage.tf` | the storage account; the `sites` container; the lifecycle rule expiring `uploads/` |
| `secrets.tf` | Key Vault (RBAC); the generated secrets; the sign-in secrets, created as `unset` for someone to fill |
| `live.tf` | Web PubSub; the `fling` hub with its event handler to the host |
| `mail.tf` (with mail) | Communication Services; the Email service and its domain; the sender username; the domain's DNS records with a zone |
| `iam.tf` | the host's and the deploy's user-assigned identities; the federated credential for GitHub OIDC (repository and environment subject); role assignments |

The module's tests run as `terraform test` with mocked providers (`infra/tests/`), and
`scripts/check-terraform.mjs` checks the module and `infra/examples/basic` in every gate.

## 6. Deploy and local runtime

- **Deploy:** `deploy-azure.yml`, run by hand for a ref, signs in with the federated credential.
  In order, it:
  1. builds the web app and the bundle (with the instance's `instance.json`) and the image, and
     pushes it to the registry;
  2. points the Container App and the jobs at the image;
  3. starts the migrate job and waits for it to succeed;
  4. polls `/.well-known/fling` for the release;
  5. purges Front Door;
  6. runs the e2e smoke test.
- **Local runtime:** none of its own. The Node runtime (`packages/e2e/src/local.ts`) runs the same
  host, and the Azure adapters' conformance runs against the Cosmos DB Linux emulator (vNext) and
  Azurite.
- **Emulators in CI:** Azurite and the Cosmos DB emulator as service containers. Web PubSub has
  no emulator; its local tool proxies to a real service, so the hub is tested with a fake, as AWS
  fakes API Gateway's management API. Communication Services is tested with a stubbed client.

## 7. Capabilities

- Everything except `servers` and `serversEgress`.
- `live` is on with Web PubSub.
- `email` and `invites` are on with Communication Services.
- `servers` stays off: the entry point refuses to start with `SERVERS` on.

## 8. Gaps and open questions

- **Not yet run on a real subscription.** The adapters pass their suites on the emulators and
  fakes, and the module plans against mocked providers. These need a real instance to confirm:
  the Front Door wildcard managed certificate (announced GA in June 2025; older Learn pages still
  say no; the alternative is a Key Vault certificate), the Web PubSub event handler through Front
  Door, ACS's status codes for throttling and suppression, and the Cosmos DB batch limits against
  the service quotas.
- **The origin accepts the internet.** Container Apps ingress takes IP ranges but not the
  `AzureFrontDoor.Backend` service tag, so the Container App's own address is reachable. The
  origin-verify secret refuses what skipped Front Door; a VNet with a network security group would
  close the address itself.
- **Secrets in state:** the session secret and the site HMAC key are generated in memory and
  written to Key Vault with a write-only attribute, so they are never in state. The origin-verify
  and live-events secrets are, as AWS's origin-verify secret is, because Front Door's rule and the
  hub's event handler URL hold their values. The sign-in client secrets are set outside Terraform.
- **The 20 GB partition** is the ceiling of an instance. Measure a real instance's table size
  before committing. Postgres is the escape.
- **Uploads pass through the host**, so a deploy's bytes cost Front Door and Container Apps
  traffic. A store-side binding would need Blob Storage to sign request headers.
- **The emulator is a preview.** The vNext Linux emulator passes every suite; its tag moves.
- **Site servers** on Container Apps dynamic sessions with custom containers: a session per site
  version from a pool running the core's shell, the pool's management endpoint reachable only
  with the host's identity, egress set per pool. To confirm first: session lifetime, cold start
  and per-pool egress. The alternative is one Container App per site.

## 9. Sources

- [Cosmos DB transactional batch](https://learn.microsoft.com/azure/cosmos-db/transactional-batch)
- [Cosmos DB partitioning](https://learn.microsoft.com/azure/cosmos-db/partitioning-overview)
- [Cosmos DB time to live](https://learn.microsoft.com/azure/cosmos-db/nosql/time-to-live)
- [Cosmos DB Linux emulator (vNext)](https://learn.microsoft.com/azure/cosmos-db/emulator-linux)
- [Service SAS](https://learn.microsoft.com/rest/api/storageservices/create-service-sas)
- [Put Blob](https://learn.microsoft.com/rest/api/storageservices/put-blob)
- [Web PubSub event handlers](https://learn.microsoft.com/azure/azure-web-pubsub/howto-develop-eventhandler)
- [Web PubSub CloudEvents over HTTP](https://learn.microsoft.com/azure/azure-web-pubsub/reference-cloud-events)
- [Communication Services Email](https://learn.microsoft.com/azure/communication-services/concepts/email/email-overview)
- [Front Door wildcard domains](https://learn.microsoft.com/azure/frontdoor/front-door-wildcard-domain)
- [Front Door managed certificates for wildcard domains, GA](https://mc.merill.net/message/AZ496631)
- [Front Door rules engine](https://learn.microsoft.com/azure/frontdoor/front-door-rules-engine)
- [Container Apps jobs](https://learn.microsoft.com/azure/container-apps/jobs)
- [Container Apps secrets from Key Vault](https://learn.microsoft.com/azure/container-apps/manage-secrets)
- [Container Apps dynamic sessions](https://learn.microsoft.com/azure/container-apps/sessions)
