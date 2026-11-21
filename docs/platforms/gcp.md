<!-- markdownlint-disable MD013 -->

# Platform: Google Cloud

How Fling would meet the [logical platform](../design/platform.md) on Google Cloud. There is no
deploy guide yet.

## 1. Status and shape

**Status:** proposed. No code exists. This document is the design to build from.

**Shape:** one host that routes. The [shared Node host](../design/platform.md#5-shared-building-blocks-for-new-platforms)
runs as one Cloud Run service that answers the app host and the sites host. Behind it are:
- a global external Application Load Balancer, for TLS and the wildcard certificate;
- Cloud CDN, for public, immutable objects.

Google Cloud has no JS edge (§3), so the routing decision runs in Cloud Run, as it does in the
Cloudflare Worker.

**Cost floor (idle):** roughly $20–25 a month.
- The load balancer's forwarding rule costs about $18 a month, whatever the traffic.
- Cloud Run scales to zero.
- Firestore, GCS, Secret Manager and Cloud Scheduler sit within or near their free tiers at idle.
- `live` with Memorystore adds about $35 a month or more.

**Effort:** large.
- Two new adapters: Firestore and GCS.
- The shared Node host and the shared HTTP mailer.
- A Terraform module.
- A deploy workflow.
- Site servers on Cloud Run, which are the biggest single piece.

## 2. Mapping

| Element | Google Cloud service | Adapter | Notes |
|---|---|---|---|
| Table | Firestore in Native mode, one database, one collection `items` | `platforms/gcp/src/table/firestore.ts` | See "Table on Firestore" below |
| Blobs | Cloud Storage (`sites` bucket), V4 signed URLs | `platforms/gcp/src/blobs/gcs.ts` | GCS checks MD5 or CRC32C on upload, never SHA-256 ([known gap](../design/platform.md#6-known-gaps-in-the-contract)). Until the contract changes, uploads go through the host's signed routes |
| Route table | Firestore, behind an in-process cache | `platforms/gcp/src/route-table/cached.ts` over the core's `TableRouteTable` | The Cloudflare `CachedRouteTable` pattern: a new key is visible at once, a changed one after the cache TTL |
| Sites host | Cloud Run (the Node host) behind the load balancer and Cloud CDN | `platforms/node` (shared) | See §3 |
| Live hub | WebSockets on Cloud Run, with a fan-out between instances | `platforms/gcp/src/live.ts` | Fan-out over Memorystore for Redis pub/sub, or Pub/Sub. Otherwise one instance only, or `live` off at first |
| Mailer | none native: the shared HTTP mailer (a transactional provider's API) | `platforms/node/src/mail/http.ts` (shared) | Google Cloud has no email-sending service |
| Site servers | Cloud Run, one service per site, a revision per version | `platforms/gcp/src/servers/` | See "Site servers" below |
| Server logs | Cloud Logging (`entries.list`) | `platforms/gcp/src/servers/server-logs.ts` | Read-only; Cloud Run writes the server's stdout |
| Ticks | Cloud Scheduler calling the service over HTTP, with an OIDC token | `platforms/gcp/src/entry.ts` | `notify` every minute (with mail), `maintain` hourly. The host checks the token's service account |
| Migrations | a Cloud Run job, run by the deploy | `platforms/gcp/src/migrate.ts` | It runs the same image and loops until done |
| Secrets | Secret Manager | `platforms/gcp/src/secrets.ts` | Read at start-up. Generated secrets are added as versions outside Terraform, so they stay out of state |
| Sign-in | (core OIDC) | — | The client secrets are in Secret Manager |

### Table on Firestore

- **Layout:** each item is a document in one collection. It holds the fields `pk`, `sk`, `data`
  and `expiresAt`, plus `ttl` as a Timestamp. The document ID is a hash of `pk` and `sk`, because
  IDs may not contain `/` and are capped at 1,500 bytes. A composite index on `(pk ASC, sk ASC)`
  serves `query`, and `reverse` is the same index read descending.
- **Order:** Firestore orders strings by their UTF-8 encoded bytes, which is the `compareSk`
  order. A prefix query is the range `[prefix, prefix + U+FFFF)`, checked against the
  conformance suite's prefix cases.
- **Consistency and transactions:** reads are strongly consistent. Server-side transactions span
  documents and collections, well above `TRANSACT_MAX` (25).
- **Conditions:** each condition becomes a read inside the transaction (`ifAbsent`, `ifExists`,
  `fieldEquals`) before its write, and `ConditionFailed` carries the op index. `add` is
  `FieldValue.increment`.
- **Expiry:** a TTL policy on `ttl` deletes expired documents, usually within 24 hours. As on
  DynamoDB, every read and condition also treats an item past its `expiresAt` as absent.
- **Paging:** the cursor is the core's `encodeCursor(sk)` keyset cursor, read with `startAfter`.

### Site servers

- **What runs:** one Cloud Run service per site, named by the core's naming. Each runs a generic
  runner image. The image holds the core's shell (strips the environment, enforces wall time and
  body limits). The version's `_fling/server.mjs` comes from a Cloud Storage volume mount, so
  there is no build step per deploy.
- **Versions:** each version and configuration is a revision with a tag. `goLive` moves the
  traffic to the new revision, and `probe` calls the revision's tag URL.
- **Isolation:**
  - Ingress is internal plus the load balancer.
  - Invoker IAM lets only the sites host's service account call the service.
  - Each service runs as its own service account, which has no rights.
- **Egress `none`:** Direct VPC egress with all traffic sent into a VPC that has no Cloud NAT
  and a deny-all egress firewall rule.
- **Limits:** the wall-time cap is the request timeout, up to 60 minutes. Concurrency and
  max-instances bound each site.

## 3. Edge and sites host

The Node host runs `routeSiteRequest` for every request to `*.<sites domain>`:
- A rewrite streams the object from GCS, adds the decision's headers, and sets `Cache-Control`
  public only for public sites.
- A response is returned directly.
- An invoke calls the site's Cloud Run service with the viewer and site headers and an ID token.

Cloud CDN in front caches what is marked public, keyed by host and path. Private sites are never
cached at the edge.

Google Cloud has no edge that runs this decision. Service Extensions plugins run WebAssembly
(Rust, Go or C++) over the Proxy-Wasm ABI, not JS. They are generally available on Cloud Load
Balancing but in Preview on Media CDN. Porting the decision to Wasm would fork it, which the
logical platform rules out.

## 4. Domains and TLS

- One Google-managed certificate from Certificate Manager covers the hostname and `*.hostname`.
  It is validated by a DNS authorisation and attached to the load balancer through a certificate
  map.
- Cloud DNS holds the zone, the authorisation's CNAME record, and A and AAAA records for both
  names, pointing at the load balancer's global IP.
- The Cloud Run service accepts traffic only from the load balancer (ingress
  `internal-and-cloud-load-balancing`), so no origin secret is needed.

## 5. Infrastructure as code

Proposed as a Terraform module at `platforms/gcp/infra` on the `google` and `google-beta`
providers, versioned by `infra-gcp-v<x.y.z>` tags. Ownership is split as on AWS: Terraform owns
the shape, the deploy owns the image, and the app owns documents and objects.

| File | Resources |
|---|---|
| `main.tf` | `google_project_service` for each API used; `google_artifact_registry_repository` for images |
| `api.tf` | `google_cloud_run_v2_service` (the Node host, placeholder image, `ignore_changes` on it); `google_cloud_run_v2_job` (migrate) |
| `edge.tf` | `google_compute_global_address`; `google_compute_region_network_endpoint_group` (serverless NEG); `google_compute_backend_service` with Cloud CDN on; `google_compute_url_map`; `google_compute_target_https_proxy`; `google_compute_global_forwarding_rule`; HTTP-to-HTTPS redirect |
| `certs.tf` | `google_certificate_manager_dns_authorization`; `google_certificate_manager_certificate` (hostname and wildcard); `google_certificate_manager_certificate_map` and its entries |
| `dns.tf` | `google_dns_record_set` for A, AAAA and the authorisation CNAME (the zone is looked up) |
| `data.tf` | `google_firestore_database` (Native mode, PITR, delete protection); `google_firestore_index` `(pk, sk)`; `google_firestore_field` TTL on `ttl` |
| `storage.tf` | `google_storage_bucket` for `ui` and `sites` (uniform access, lifecycle on `uploads/`); bucket IAM |
| `secrets.tf` | `google_secret_manager_secret` for each secret (versions added outside Terraform) |
| `schedule.tf` | `google_cloud_scheduler_job` for `notify` (with mail) and `maintain`, with an OIDC token for the scheduler's service account |
| `iam.tf` | `google_service_account` for the host, scheduler and deploy; `google_iam_workload_identity_pool` and `google_iam_workload_identity_pool_provider` for GitHub OIDC, limited to the repository and environment; role bindings |
| `servers.tf` (with servers) | A runner service account; a zips bucket; `google_compute_network` and subnet with no NAT, plus a deny-all egress `google_compute_firewall` (egress `none`); the host's right to create services under the site prefix only |
| `live.tf` (with Memorystore) | `google_redis_instance` and its VPC access |

Tests run as `terraform test` with mocked providers, which `scripts/check-terraform.mjs` would
learn to run for each module.

## 6. Deploy and local runtime

- **Deploy:** a `deploy-gcp.yml` workflow authenticates through Workload Identity Federation. In
  order, it:
  1. builds the image and pushes it to Artifact Registry;
  2. deploys a new revision;
  3. runs the migrate job until done;
  4. polls `/.well-known/fling`;
  5. syncs the UI and the sites' own pages to GCS;
  6. runs the e2e smoke test.
- **Local runtime:** the Node host over the Firestore emulator and fake-gcs-server, added to
  `packages/e2e/src/local.ts`.
- **Emulators in CI:** the Firestore emulator and fake-gcs-server as service containers next to
  DynamoDB Local and MinIO.

## 7. Capabilities

- At first, everything except `live`, `servers` and `serversEgress`, plus `email` once the HTTP
  mailer is configured.
- `live` turns on with a fan-out (Memorystore or Pub/Sub).
- `servers` turns on with the Cloud Run site servers. `serversEgress` follows the egress setting.

## 8. Gaps and open questions

- **SHA-256 upload binding:** GCS validates only MD5 and CRC32C (`x-goog-hash`), so the
  [contract change](../design/platform.md#6-known-gaps-in-the-contract) decides whether uploads
  can go direct. Until then they pass through the host's signed routes.
- **The 32 MiB request cap:** Cloud Run limits HTTP/1 requests to 32 MiB (no cap on HTTP/2), and
  this binds uploads through the host. The options are end-to-end HTTP/2 or keeping uploads under
  the cap.
- **WebSocket lifetime:** Cloud Run's request timeout is at most 60 minutes. Whether that also
  bounds a WebSocket connection is unconfirmed, and clients must reconnect if it does.
- **Firestore prefix ranges:** the `U+FFFF` upper bound has to be checked against keys that
  contain characters above the Basic Multilingual Plane.
- **Cold starts:** a scale-to-zero sites host adds start-up latency to the first site request.
  A minimum of one instance costs about $10–15 a month more.
- **Firestore TTL deletion lag:** deletion can take more than 24 hours, so reads must filter
  expired items, as the DynamoDB adapter does.
- **Site servers per site:** check Cloud Run's per-project service quotas (default 1,000
  services per region) against the expected number of sites with servers.

## 9. Sources

- [Cloud Run quotas and limits](https://docs.cloud.google.com/run/quotas)
- [Cloud Storage data validation (MD5, CRC32C)](https://docs.cloud.google.com/storage/docs/data-validation)
- [Cloud Storage canonical requests](https://docs.cloud.google.com/storage/docs/authentication/canonical-requests)
- [Service Extensions release notes](https://docs.cloud.google.com/service-extensions/docs/release-notes)
- [Media CDN extensions overview](https://docs.cloud.google.com/service-extensions/docs/media-cdn-extensions-overview)
- [Service Extensions plugins with Cloud CDN](https://cloud.google.com/blog/products/networking/run-service-extensions-plugins-with-cloud-cdn/)
