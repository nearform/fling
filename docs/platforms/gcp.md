<!-- markdownlint-disable MD013 -->

# Platform: Google Cloud

How Fling meets the [logical platform](../design/platform.md) on Google Cloud. Deploying an
instance: [platforms/gcp/DEPLOY.md](../../platforms/gcp/DEPLOY.md).

## 1. Status and shape

**Status:** supported. The adapters pass the conformance suites against the Firestore emulator and
fake-gcs-server in CI, the Terraform module passes its tests against mocked providers, and the
`Deploy (Google Cloud)` workflow deploys an instance by hand from a release tag. Site servers are
not built yet (§7).

**Shape:** one host that routes. The [shared Node host](../design/platform.md#5-shared-building-blocks-for-new-platforms)
runs as one Cloud Run service that answers the app host and the sites host. In front of it is a
global external Application Load Balancer, for TLS and the wildcard certificate, with Cloud CDN on
the sites' backend when it is switched on.

Google Cloud has no JS edge (§3), so the routing decision runs in Cloud Run, as it does in the
Cloudflare Worker.

**Cost floor (idle):** roughly $20–25 a month.
- The load balancer's forwarding rules cost about $18 a month, whatever the traffic.
- Cloud Run scales to zero.
- Firestore, Cloud Storage, Secret Manager and Cloud Scheduler sit within or near their free tiers
  at idle.

## 2. Mapping

| Element | Google Cloud service | Adapter | Notes |
|---|---|---|---|
| Table | Firestore in Native mode, one database, collection `items` | `platforms/gcp/src/table/firestore.ts` | See "Table on Firestore" below |
| Blobs | Cloud Storage (`sites` bucket), V4 signed URLs | `platforms/gcp/src/blobs/gcs.ts` | Cloud Storage checks an upload's MD5 or CRC32C, never its SHA-256, so a signed PUT binds the manifest's MD5 (`Content-MD5`, with Content-Type and Cache-Control; `uploadDigest = 'md5'`, [§3.2](../design/platform.md#32-blobs)); a manifest without one goes through the host's upload routes (`HostUploads`). The service signs as its own service account through the IAM Credentials API, with no key |
| Route table | Firestore, behind an in-process cache | the shared `CachedRouteTable` (`platforms/node/src/route-table/cached.ts`) over the core's `TableRouteTable` | A new key is visible at once, a changed one within the cache's 5 s |
| Sites host | Cloud Run (the Node host) behind the load balancer | `platforms/node/src/host.ts` (shared), wired in `platforms/gcp/src/host.ts` | See §3 |
| Live hub | WebSockets on Cloud Run, the Node host's in-process hub | `platforms/gcp/src/host.ts` (`MemoryLiveHub`) | Every socket of a room must reach one process, so `LIVE_URL` is set only with `max_instances = 1` |
| Mailer | none native: the shared SMTP mailer (a transactional provider's SMTP) | `platforms/node/src/mail/smtp.ts` (shared) | Google Cloud has no email-sending service. Outbound port 25 is blocked; 465 and 587 are not |
| Site servers | not yet | — | `SERVERS` must be off; the service refuses to start otherwise |
| Ticks | Cloud Scheduler calling the service over HTTPS, with an OIDC token | `platforms/gcp/src/ticks.ts` | `notify` every minute (with mail), `maintain` every 15 minutes (`maintenance_schedule`, with a 300 s attempt deadline), through the load balancer to the app host. The service verifies the Google-signed ID token (google-auth-library: signature, issuer, expiry, the app origin as audience) and its service account |
| Migrations | the host's `POST /ticks/migrate`, called by the deploy | `platforms/node/src/host.ts` (shared) | With an ID token of the deploy service account; looped until done |
| Secrets | Secret Manager, in the service's environment | `platforms/gcp/src/env.ts` | Cloud Run fills the environment from each secret's latest version when an instance starts. Generated secrets are written by Terraform with write-only attributes, so they stay out of state; secrets to fill by hand start as `unset`, which reads as not set |
| Sign-in | (core OIDC) | — | The client secrets are in Secret Manager |

### Table on Firestore

- **Layout:** each item is a document in one collection. Its ID is a SHA-256 of `pk` and `sk`,
  because IDs may not contain `/` and are capped at 1,500 bytes. It holds `pk`, `s` (the sort
  key's UTF-8 bytes, a Bytes value), `data` (the item's other fields as JSON, exempt from
  indexing) and, when the item expires, `ttl` as a Timestamp.
- **Order:** Firestore orders Bytes values byte by byte, which is the `compareSk` order, so the
  order never rests on how strings compare. A prefix query is the range `[prefix, prefix + 0xFF)`:
  no UTF-8 sequence holds the byte 0xFF, so every key that starts with the prefix is inside it,
  characters above the Basic Multilingual Plane included. Composite indexes on `(pk, s)` ascending
  and descending serve `query` and `reverse`. Firestore indexes, orders and compares only the
  first 1,500 bytes of a value, so the adapter refuses a pk or sk longer than that in UTF-8; the
  core keeps every key well under it (a site's paths are at most `MAX_PATH_BYTES`, 900 bytes).
- **Values:** JSON keeps every value the port takes: NUL and lone surrogates are escaped, nested
  arrays (which Firestore refuses as values) are text, and no field name is reserved.
- **Consistency and transactions:** reads are strongly consistent. The database runs with
  pessimistic concurrency, so a transaction's reads take locks; the client retries a transaction
  that lost a conflict (up to 50 times). Transactions span documents, well above `TRANSACT_MAX`
  (25).
- **Conditions:** each condition is a read inside the transaction (`ifAbsent`, `ifExists`,
  `fieldEquals`) before its write, and `ConditionFailed` carries the op index. `update` (with
  `add`) is a read and a write in one transaction, so concurrent adds all count.
- **Expiry:** a TTL policy on `ttl` deletes expired documents, usually within 24 hours and
  sometimes later. As on DynamoDB, every read and condition also treats an item past its
  `expiresAt` as absent.
- **Paging:** the cursor is the core's `encodeCursor(sk)` keyset cursor, read with `startAfter`
  on `s`. `scan` pages in document ID order.

## 3. Edge and sites host

The Node host runs `routeSiteRequest` for every request to `*.<sites domain>`:
- A rewrite streams the object from Cloud Storage, adds the decision's headers, and sets
  `Cache-Control` public only for public sites.
- A response is returned directly.

The load balancer has two backend services on one serverless NEG: `app` for the hostname, never
cached, and `sites` for `*.hostname`. With the module's `cdn` on, Cloud CDN caches the sites'
backend under the service's own `Cache-Control`, keyed by host, path and query, for at most a
minute (`max_ttl`, since a URL stays the same across versions). The sites host sends `private` for
everything of a site that isn't public and everything on a share link, so the edge never keeps
those. It is off by default, so a change of access or a rollback is seen at once.

Google Cloud has no edge that runs this decision. Service Extensions plugins run WebAssembly
(Rust, Go or C++) over the Proxy-Wasm ABI, not JS. They are generally available on Cloud Load
Balancing but in Preview on Media CDN. Porting the decision to Wasm would fork it, which the
logical platform rules out.

**View counts.** A page's beacon posts to `/_fling-seen` on the site's host. The Node host counts it
in the process's `ViewCounter`. It writes the counts after a view, at most every 10 seconds, and on
a 60-second timer for a site that has gone quiet. It writes once more when the host closes (Cloud
Run's SIGTERM). With CPU allocated only during requests, the timer may not run between them, so a
quiet instance's last views wait for its next request or its shutdown.

## 4. Domains and TLS

- One Google-managed certificate from Certificate Manager covers the hostname and `*.hostname`.
  It is validated by a DNS authorisation and attached to the load balancer through a certificate
  map.
- Cloud DNS holds the authorisation's CNAME record and A and AAAA records for both names, pointing
  at the load balancer's global addresses, when the module is given the zone; otherwise its
  `dns_records` output lists them for wherever the domain's DNS is.
- The Cloud Run service accepts traffic only from the load balancer (ingress
  `internal-and-cloud-load-balancing`) and needs no invoker IAM, so no origin secret is needed.
  HTTP is redirected to HTTPS.

## 5. Infrastructure as code

The Terraform module is [`platforms/gcp/infra`](../../platforms/gcp/infra), on the `google` and
`google-beta` providers. It is versioned by `infra-gcp-v<x.y.z>` tags, separate from release tags.
Terraform owns the shape, `deploy-gcp.yml` owns the image, and the app owns documents and objects.

| File | Resources |
|---|---|
| `main.tf` | `google_project_service` for each API used; `google_artifact_registry_repository` for images |
| `api.tf` | `google_cloud_run_v2_service` (the Node host, placeholder image, `ignore_changes` on it), its environment and secrets |
| `edge.tf` | Global IPv4 and IPv6 addresses; the serverless NEG; `app` and `sites` backend services (Cloud CDN on `sites` with `cdn`); URL maps; HTTPS and HTTP proxies; forwarding rules; the HTTP-to-HTTPS redirect |
| `certs.tf` | `google_certificate_manager_dns_authorization`; `google_certificate_manager_certificate` (hostname and wildcard); the certificate map and its entries |
| `dns.tf` | `google_dns_record_set` for A, AAAA and the authorisation CNAME (with `dns_zone`) |
| `data.tf` | `google_firestore_database` (Native mode, pessimistic concurrency, PITR, delete protection); `google_firestore_index` `(pk, s)` both ways; `google_firestore_field` TTL on `ttl`, no indexes on `data` |
| `storage.tf` | The `sites` bucket (uniform access, public access prevented, lifecycle on `uploads/`); bucket IAM |
| `secrets.tf` | `google_secret_manager_secret` for each secret; write-only versions (generated, or the `unset` placeholder) |
| `schedule.tf` | `google_cloud_scheduler_job` for `maintain` and, with mail, `notify`, with an OIDC token for the scheduler's service account |
| `iam.tf` | Service accounts for the service, the scheduler and the deploy; `google_iam_workload_identity_pool` and its provider for GitHub OIDC, limited to the repository and owner ids and the environment; role bindings |

`infra/tests/*.tftest.hcl` run against mocked providers in the gate (`scripts/check-terraform.mjs`).

## 6. Deploy and local runtime

- **Deploy:** `.github/workflows/deploy-gcp.yml`, by hand from a release tag, authenticates
  through Workload Identity Federation. In order, it:
  1. builds the service (`platforms/gcp/scripts/build.mjs`, with `instance.json`), the UI and the
     `.mcpb`, and the image (`platforms/gcp/Dockerfile`), and pushes it to Artifact Registry;
  2. deploys a new revision on it;
  3. loops `POST /ticks/migrate` until done;
  4. polls `/.well-known/fling`;
  5. runs the e2e smoke test.

  The web UI and Fling's pages for the sites are in the image, so there is nothing to sync. The
  `deploy` Terraform output becomes the `GCP_DEPLOY_CONFIG` GitHub variable.
- **Local runtime:** the `node` runtime of `pnpm e2e` runs the Node host every Google Cloud
  instance runs; the GCP adapters are held to the same behaviour by the conformance suites.
- **Emulators in CI:** the Firestore emulator and fake-gcs-server, started by `ci.yml` beside
  DynamoDB Local, MinIO and Postgres (`platforms/gcp/tests/services.ts`). fake-gcs-server checks
  neither a signed URL's signature nor its Content-MD5, so the Blobs suite sends the signed URLs
  through a stand-in for Cloud Storage's documented V4 checks first (`tests/signed-urls.ts`).

## 7. Capabilities

- Everything except `servers` and `serversEgress`.
- `live` needs `max_instances = 1` (the module's default); with more, the module leaves `LIVE_URL`
  unset and review pages poll.
- `email`, `invites` and the email channel of notifications need the module's `mail`.

## 8. Gaps and open questions

- **Size.** The route table is Firestore behind a cache, so it does not bound the number of
  sites. Maintenance's queue (about 1,000–3,000 sites' work an hour) is the throughput limit.
- **Site servers:** a Cloud Run service per site, a revision per version, egress `none` through
  Direct VPC egress into a VPC with no route out. Not built; check Cloud Run's per-project service
  quota (1,000 per region by default) against the sites expected to have servers.
- **Live rooms across instances:** they need a fan-out between instances (Memorystore for Redis
  pub/sub, or Pub/Sub) before the service can scale out with `live` on.
- **The 32 MiB request cap:** Cloud Run limits HTTP/1 requests to 32 MiB, which bounds uploads
  through the host (`MAX_REQUEST_BYTES` defaults to it). Uploads with an MD5 go straight to Cloud
  Storage.
- **Unconfirmed without a real project:** that Cloud Storage refuses a signed PUT whose body does
  not match its signed `Content-MD5` (documented, and what the test stand-in does); that the load
  balancer passes the original Host header to Cloud Run (the Node host routes by it); that a
  WebSocket through the load balancer lasts the service's request timeout; and the Firestore IAM
  condition that holds the service to its own database.
- **Cold starts:** a scale-to-zero service adds start-up latency to the first request.
  `min_instances = 1` costs about $10–15 a month more.

## 9. Sources

- [Cloud Run quotas and limits](https://docs.cloud.google.com/run/quotas)
- [Cloud Storage data validation (MD5, CRC32C)](https://docs.cloud.google.com/storage/docs/data-validation)
- [Cloud Storage canonical requests](https://docs.cloud.google.com/storage/docs/authentication/canonical-requests)
- [Firestore value type ordering](https://firebase.google.com/docs/firestore/manage-data/data-types#value_type_ordering)
- [Firestore concurrency modes](https://cloud.google.com/firestore/docs/transaction-data-contention)
- [Cloud Scheduler with OIDC tokens](https://cloud.google.com/scheduler/docs/http-target-auth)
- [Service Extensions release notes](https://docs.cloud.google.com/service-extensions/docs/release-notes)
- [Media CDN extensions overview](https://docs.cloud.google.com/service-extensions/docs/media-cdn-extensions-overview)
