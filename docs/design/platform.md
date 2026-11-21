<!-- markdownlint-disable MD013 -->

# Design: the logical platform

Status: describes the contract AWS and Cloudflare meet today. The building blocks for new
platforms ([§5](#5-shared-building-blocks-for-new-platforms)) are proposals.

Fling is one core and several **platforms**. The core holds every rule. A platform is
`platforms/<cloud>/`: an entry point plus adapters that put the core on one cloud's primitives.
This document defines the **logical platform**, the contract every platform meets whatever cloud
it runs on, and the design choices behind it. Each platform has a **platform doc** in
[docs/platforms/](../platforms/README.md). Every platform doc uses the same template and maps
each element of this contract onto one cloud.

Terms are CONTEXT.md's.

## 1. Design choices

Each choice lists the reason for it and the file that owns it.

1. **The core is cloud-agnostic.** `apps/api` and `packages/shared` import no cloud SDK, and Biome
   enforces this (`biome.json`).
   - The core reads its drivers from config (`STORE_DRIVER`, `STORAGE_DRIVER`, `KVS_DRIVER`,
     `MAIL_DRIVER`, in `apps/api/src/config.ts`).
   - A platform passes its adapters to `buildDeps` (`Adapters`, `apps/api/src/deps.ts`).
   - If config names a cloud driver and no adapter is passed, `buildDeps` throws rather than fall
     back to memory.
   - *Why:* a feature is written once and runs on every cloud, and the local runtime runs the same
     code.
2. **Platforms implement a Table, not the Store.** `Records` (`apps/api/src/store/records.ts`) is
   the whole data model, written once over the small `Table` port.
   - `Table` has only `pk`/`sk` and no secondary indexes. A second access path is an index item,
     written in the same transaction as the item it points to.
   - *Why:* any store with conditional writes and multi-item transactions can hold Fling. The data
     model and its migrations never fork per cloud.
3. **One routing decision, and the edge only rewrites.** `routeSiteRequest`
   (`packages/shared/src/site-routing.ts`) decides everything about a request to a sites host:
   rewrite to a file, redirect to sign-in, refuse, invoke a site server, or answer itself.
   - A platform's sites host does the lookups the decision asks for and maps its answer onto the
     runtime.
   - *Why:* access control on sites must behave identically everywhere. The decision is kept to a
     JS subset small enough for the most limited edge (CloudFront Functions) and runs unchanged on
     the others.
4. **Capabilities, never platform checks.** Instances differ only in what
   `/.well-known/fling` advertises (`capabilities`, `apps/api/src/instance.ts`;
   `CONFIGURED_CAPABILITIES`, `packages/shared/src/instance.ts`). Nothing checks which cloud it runs
   on.
   - A platform without a live hub leaves `LIVE_URL` unset, so `live` is off.
   - A platform without site servers leaves `SERVERS` off, so `servers` is off.
   - *Why:* clients (the CLI, MCP servers, the UI) are instance-agnostic. A new platform can ship
     before it has every element.
5. **The Table is the queue.** The notifications outbox, the revocation list and the leases are
   all Table items (`apps/api/src/notifications/`). The platform supplies only the clock:
   - a tick every minute (`notify`);
   - a tick every hour (`maintain`);
   - a `migrate` run from the deploy.

   *Why:* there is no queue service to map per cloud, and every cloud can call an endpoint on a
   schedule.
6. **Sign-in is the core's.** Generic OIDC and Google sign-in live in `apps/api/src/auth/oidc.ts`
   (`identityProvidersFor`), and emailed sign-in links in `sign-in-link.ts`. The `identities`
   field in `Adapters` exists for tests. A platform only stores the client secrets.
   - *Why:* sign-in works the same on every cloud, and no platform ties Fling to its own identity
     product.
7. **Signing is the core's.** Sessions, site passes, live tickets, site-server options and the
   signed blob routes are HMAC-signed with the platform's secrets (`apps/api/src/blobs/signed-url.ts`
   among others). The only cloud-native signer is the S3 presigned URL.
   - *Why:* an object store with no presigned URLs, or with weak ones, can still serve uploads
     through the platform's own host.
8. **Every platform passes everything.** Every adapter, the core's memory and fs adapters
   included, passes `packages/conformance`. Every platform's local runtime passes the e2e scenario
   (`packages/e2e/src/scenario.ts`), and the deployed instance runs it as a smoke test.

## 2. Shape of a platform

| Shape | How the sites host runs | Platforms |
|---|---|---|
| **Edge function** | A CDN runs the routing decision at the edge against an edge key-value store, then serves from object storage. The API runs separately. | AWS (CloudFront Function + KeyValueStore) |
| **One host that routes** | One process routes by host. It answers the app's API and UI, and runs the routing decision for the sites host itself. A CDN in front only terminates TLS and caches. | Cloudflare (one Worker); proposed for GCP, Azure, Fly.io, DigitalOcean and self-host |

The second shape needs a runtime that runs JS for every site request. In exchange, the sites host
can add the decision's headers to every response; a viewer-request function cannot.

## 3. The contract

Each element uses the same headings:
- **Port:** the interface and its file.
- **Semantics:** what an adapter must keep.
- **Conformance:** the suite that proves it.
- **Gates:** the capability that is off without it.

### 3.1 Table

- **Port:** `Table` (`apps/api/src/table/types.ts`).
- **Semantics:**
  - Methods: `get`, `query(pk, {skPrefix, limit, cursor, reverse})`, `scan` (migrations only),
    `put`, `update(set/add)`, `delete` and `transact`.
  - **Strong consistency.** Of N concurrent `ifAbsent` puts, conditional deletes or transactions,
    exactly one wins.
  - **Conditions** on put, update and delete: `ifAbsent`, `ifExists`,
    `fieldEquals(field, value | undefined, {orAbsent})`. A failure throws `ConditionFailed`.
  - **Transactions across partition keys** of up to `TRANSACT_MAX` (25) items, all or nothing.
    This is the requirement that rules out stores whose transactions stay inside one partition.
  - **Order:** `sk` in UTF-8 byte order (`compareSk`), with prefix match and `reverse`. The
    cursor is opaque and stays valid after the item it ended on is deleted.
  - **Atomic `add`**: a missing field counts as 0, and concurrent adds all count.
  - **`expiresAt`** (an exact ISO string) hides an item from every read and condition from that
    instant, whenever the backend purges it.
  - `update` never creates an item.
- **Conformance:** `tableConformance`, `storeConformance` with `store-notifications`, and
  `migrationsConformance` (`packages/conformance/src/`).
- **Gates:** nothing. Every platform needs it.

### 3.2 Blobs

- **Port:** `Blobs` (`apps/api/src/blobs/types.ts`).
- **Semantics:**
  - Methods: `presignPut`, `presignGet`, `head`, `put`, `get`, `copy`, `delete` and
    `deletePrefix`.
  - **A presigned PUT accepts only the bytes whose digest was signed.** The manifest carries each
    file's SHA-256 and, from clients that send it, its MD5 (base64). `presignPut` binds whichever
    one its store checks: the SHA-256 on S3 and R2 and through the core's signed routes, the MD5
    (`Content-MD5`) on GCS, Azure Blob and S3-compatible stores (`S3Blobs` with `digest: 'md5'`).
    The binding also covers content type and cache-control and is tied to its key. The client
    sends exactly the headers `presignPut` returns. Clients upload directly; the API never sees
    the bytes.
  - A presigned GET expires and is tied to its key.
  - `deletePrefix` pages past one listing.
  - The port has no multipart upload. Large uploads through MCP are chunked in the Table and
    assembled on the server.
  - A store that checks only an MD5, asked to presign a file whose MD5 the client did not send (an
    older CLI), signs the host's upload route instead (`HostUploads`,
    `apps/api/src/blobs/host-uploads.ts`). The host checks the SHA-256 itself and writes the
    bytes with `put`, so they pass through it and its request-size limit applies. Cloudflare
    serves the same routes with R2's own check.
- **Conformance:** `blobsConformance`.
- **Gates:** nothing.

### 3.3 Route table and sites host

- **Port:** `RouteTable` (`apps/api/src/route-table/types.ts`) has `get`, `put` and `delete`
  over string keys. The keys are `site:<label>`, `share:<token>`, `path:<siteId>/<folder>`,
  `revoked:<mac>` and `cfg:site-hmac`.
- **Semantics:**
  - Reads happen on every site request, at the edge or in the sites host.
  - Eventual consistency is allowed. A platform with a delay supplies `waitReady`
    (`apps/api/src/types.ts`), which the remote MCP polls. The smoke test waits it out with
    `--propagation-seconds`.
  - The sites host gives `routeSiteRequest` the lookups it needs: routes, the cookie key,
    revocations and HMAC-SHA256. It then maps the decision:
    - a rewrite to `/sites/<id>/<v><path>` in object storage, or to one of Fling's own pages;
    - a synthetic response (redirects, 403/405/503, `Set-Cookie` for site passes);
    - an invoke of the site server with the viewer and site headers.

    It adds the decision's `headers` wherever its runtime allows.
- **Conformance:** `routeTableConformance` covers the storage side. The edge shell has
  per-platform tests only (§6).
- **Gates:** nothing.

### 3.4 Live hub

- **Port:** `LiveHub.publish(siteId, message)` (`apps/api/src/live.ts`).
- **Semantics:**
  - The core owns rooms (`joinRoom`, `receive`, `leaveRoom`, `broadcast`) and the 60-second
    tickets. A hub only keeps a site's WebSocket connections and sends to them.
  - A hub whose connections outlive one process keeps them as live connection records through the
    Store, as AWS does.
  - The transport is WebSockets at `LIVE_URL`.
- **Conformance:** `liveHubConformance`: welcome, join and leave, pointers to the room's others
  only, `publish` to the site's room and no other, and a closed or gone connection forgotten.
  `storeConformance` covers the live connection records.
- **Gates:** `live`.

### 3.5 Mailer

- **Port:** `Mailer.send(message)` (`apps/api/src/mail/types.ts`).
- **Semantics:**
  - A provider's refusal is never thrown. It is mapped to
    `{ok:false, retry, reason: throttled|transient|rejected|suppressed}`.
  - `prepareMessage` runs first, and every message is tagged `X-Fling-Batch`.
  - Queueing is the core's outbox.
- **Conformance:** `mailerConformance`.
- **Gates:** `email`, `invites` (emailed sign-in links) and the email channel of `notifications`.

### 3.6 Site servers and their logs

- **Port:** `SiteServers` and `ServerLogs` (`apps/api/src/servers/types.ts`).
- **Semantics:**
  - Methods: `activate`, `probe`, `goLive?`, `reconfigure`, `setEnabled`, `retire` and `invoke`.
    The design is in [site-servers.md](site-servers.md).
  - Runs both a fetch handler and a `node:http` server.
  - Gives a server its declared secrets and nothing of the host environment.
  - Isolates sites from each other and from Fling's storage and credentials.
  - Enforces wall time (streams included), body size and the egress setting (`none` or `open`).
- **Conformance:** `siteServersConformance` and `serverLogsConformance`.
- **Gates:** `servers` and `serversEgress`.

### 3.7 Ticks and migrations

- **Port:** entry-point handlers that call the core's `drain`, `maintain` and `runMigrations`.
- **Semantics:**
  - `notify` runs every minute (with mail) and drains the outbox. `maintain` runs hourly on every
    instance: version retention, replaced home pages, and the revocation sweep.
  - `migrate` runs from the deploy, after the new code is live, until it reports done.
  - Every tick is safe to repeat, because leases are conditional updates in the Table.
- **Conformance:** `migrationsConformance`. The ticks are covered by the e2e.
- **Gates:** notifications by email need the minute tick.

### 3.8 Secrets

- **Port:** the `Secrets` the core reads (`SECRET_SETTINGS`, `apps/api/src/config.ts`):
  - `SESSION_SECRET`, `SITE_HMAC_KEY`;
  - `OIDC_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET`;
  - `SITE_SECRETS_KEY` (site servers);
  - `ORIGIN_VERIFY_SECRET`, where an origin must refuse traffic that skipped the CDN.
- **Semantics:**
  - Secrets stay out of Terraform state and the code.
  - The platform copies the site HMAC key into the route table (`cfg:site-hmac`) wherever the
    edge reads it from there.
- **Gates:** nothing.

### 3.9 Domains and TLS

- **Semantics:**
  - The app host (UI and API) and `*.<sites domain>` are both served over TLS.
  - The sites domain may equal the app domain but must share its registrable domain, because the
    `fling_site` cookie is set on it (`SITE_COOKIE_DOMAIN`).
  - Mail is sent from `mail.<sites domain>`, a reserved site name.
  - A wildcard certificate is required.

### 3.10 Deploy and identity

- **Semantics:**
  - The repository deploys with GitHub OIDC into a role scoped to the instance. No long-lived
    cloud keys are kept in GitHub.
  - In order, the deploy:
    1. builds the artefacts (API, web UI, the sites' 404, review and robots pages, the `.mcpb`);
    2. ships them;
    3. runs `migrate`;
    4. waits for `/.well-known/fling` to report the release;
    5. runs the smoke test.
  - Infrastructure (the shape) and code (the deploy) are owned separately. The infrastructure is
    Terraform wherever the cloud has a maintained provider.

### 3.11 Local runtime and the e2e

- **Semantics:**
  - Each platform runs locally on its own emulators, added to `packages/e2e/src/local.ts`, and
    passes `packages/e2e/src/scenario.ts`.
  - Adapter suites run against emulators in CI (`.github/workflows/ci.yml`) and skip locally
    unless the services are started.

## 4. Adding a platform

A platform is `platforms/<cloud>/`. It adds:

1. driver names to the config schema (`apps/api/src/config.ts`). This is the only core change.
2. an entry point that builds `Deps` (`buildDeps` with its adapters) and handles the ticks.
3. adapters for Table, Blobs and RouteTable that pass `packages/conformance`.
4. a sites host that calls `routeSiteRequest` and adds the decision's headers to what it serves.
5. optionally, a `LiveHub` with a `LIVE_URL`, a `Mailer`, and `SiteServers` with `ServerLogs`.
   Each one turns on its capability (§3).
6. infrastructure as code, a deploy workflow and a `DEPLOY.md` that links to its platform doc.
7. a local runtime in `packages/e2e/src/local.ts`, and its emulators in CI.
8. a platform doc in `docs/platforms/`, written to the template, with a row in its index.

Differences between platforms are capability flags, never `if (platform === …)`.

## 5. Shared building blocks for new platforms

The proposed platforms ([GCP](../platforms/gcp.md), [Azure](../platforms/azure.md),
[Fly.io](../platforms/fly.md), [Vercel](../platforms/vercel.md),
[DigitalOcean and self-host](../platforms/digitalocean-self-host.md)) mostly have the *one host
that routes* shape, on a Node runtime. Writing the parts they share once keeps "write once" true:

1. **A Node host** (proposed as `platforms/node`). It is one HTTP server that does on Node what
   the Cloudflare Worker does:
   - routes by host;
   - serves the API and the UI on the app host;
   - runs `routeSiteRequest` on the sites host and streams the objects it names;
   - serves the core's signed blob routes;
   - accepts WebSocket upgrades for the live rooms, with a pluggable fan-out across instances;
   - exposes the tick and migrate endpoints behind a platform-supplied caller check.

   `apps/api/src/dev.ts` already does most of this for the local runtime. A cloud platform then
   supplies only adapters, infrastructure and a deploy.
2. **A Postgres `Table` adapter**, a sibling of the D1 one
   (`platforms/cloudflare/src/table/d1.ts`):
   - `items(pk, sk COLLATE "C", data jsonb, expires_at)` for byte order;
   - conditions checked inside one transaction (`SELECT … FOR UPDATE` and guard statements);
   - conformance run against a Postgres service in CI.

   It is the Table for Fly.io, Vercel (Neon), DigitalOcean and self-host, and the fallback on
   Azure and GCP.
3. **An HTTP mailer** for clouds without a mail service (GCP, Fly.io, DigitalOcean, self-host).
   It is one adapter for a transactional provider's API, or for SMTP, passing `mailerConformance`.

## 6. Known gaps in the contract

- **No shared conformance for edge shells.** Each sites host tests its own. The AWS route table
  (`CloudFrontRouteTable`) has no emulator and is stub-tested.
- **CI knows two platforms.** `scripts/check-terraform.mjs` checks one Terraform module, and
  `ci.yml` starts only DynamoDB Local and MinIO. Each new platform adds its module and emulators.
