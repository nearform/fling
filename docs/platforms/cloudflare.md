<!-- markdownlint-disable MD013 -->

# Platform: Cloudflare

How Fling meets the [logical platform](../design/platform.md) on Cloudflare. Deploying an
instance: [platforms/cloudflare/DEPLOY.md](../../platforms/cloudflare/DEPLOY.md).

## 1. Status and shape

**Status:** supported. It is deployed by hand from a release tag with the `Deploy (Cloudflare)`
workflow (`.github/workflows/deploy-cloudflare.yml`). It needs the Workers Paid plan, because a
remote MCP publish takes more than the Free plan's 10 ms of CPU (`limits.cpu_ms` in
`wrangler.jsonc`).

**Shape:** one host that routes. One Worker (`platforms/cloudflare/src/worker.ts`) routes by host:
- The app host gets the API core (Hono), the signed blob routes, the live upgrade and the web UI
  from Static Assets.
- The sites host runs the routing decision itself, over the route table and R2 (`src/sites.ts`).

There is no separate edge function and no origin.

## 2. Mapping

| Element | Cloudflare service | Adapter | Notes |
|---|---|---|---|
| Table | D1 (SQLite), binding `DB` | `platforms/cloudflare/src/table/d1.ts` | `items(pk, sk COLLATE BINARY, data JSON, expires_at)` (`migrations/0001_init.sql`). Conditions are guard statements whose trigger raises, inside one `db.batch()`, so a failed condition rolls back the batch. `getMany` is a `(pk, sk) IN (VALUES …)` statement per 49 keys (D1 binds at most 100 parameters), all in one `db.batch()`. Prefix queries are the range `[prefix, prefix‖x'FF')`. `purgeExpired` runs every 15 minutes |
| Blobs | R2, binding `BUCKET` | `platforms/cloudflare/src/blobs/r2.ts` | There are no S3 keys, so presigned URLs are the core's HMAC-signed routes on the Worker (`PUT /blob-upload/<key>`, `GET /blob-download/<key>`, `apps/api/src/blobs/signed-url.ts`). Uploads pass the signed SHA-256 to R2's `put`, so R2 refuses other bytes. `copy` is get then put (streamed above 1 MB) |
| Route table | Workers KV (`ROUTES`) in front of D1 | `src/route-table/cached.ts`, `src/route-table/kv.ts` | Writes go to D1 first, then KV. A KV miss is answered from D1, so a new site or share link works at once. A changed or deleted key can be stale for KV's propagation time (about 60 s). `waitReady` is a no-op. The revocation list is read from KV alone |
| Sites host | The same Worker, on the route `*.$SITES_DOMAIN/*` | `platforms/cloudflare/src/sites.ts` | See §3 |
| Live hub | Durable Objects (`LIVE_ROOMS`), one `LiveRoom` per site, with WebSocket hibernation | `platforms/cloudflare/src/live.ts` | The Worker checks the ticket and hands the admission to the site's object. `publish` is a `POST /publish` to that object. The peer is the socket's serialised attachment, so no connection records are kept |
| Mailer | Email Service, `send_email` binding `EMAIL` | `platforms/cloudflare/src/mail/email.ts` | One send per recipient. The binding's error codes map onto `MailResult`. The binding is present only with the deploy config's `MAIL`, and is restricted to its sender |
| Site servers | Worker Loader (Dynamic Workers, in beta), binding `LOADER`, with the `SERVER_RATE_LIMIT` rate limit | `platforms/cloudflare/src/servers/runtime.ts`, `isolate.ts`, `entrypoints.ts` | One isolate per site, version and run (`site:<siteId>:<versionId>:<run>`). The run is a keyed hash of the options, sealed with AES-256-GCM in R2, and the route value's `t` names it, so there is no `goLive`. The isolate gets `SiteFiles` and `ServerTail`. Cloudflare enforces `SERVER_CPU_MS`; the Worker enforces wall time, body size and the rate limit |
| Server logs | R2 `server-logs/` | `platforms/cloudflare/src/servers/logs.ts` | Pieces are written once a second per isolate and compacted every 15 minutes into one chunk per hour. An R2 lifecycle rule deletes them after `SERVER_LOG_DAYS` |
| Ticks | Cron Triggers on the Worker's `scheduled` handler | `platforms/cloudflare/src/worker.ts` | `* * * * *` drains the outbox. It is rendered only with `MAIL` (`scripts/config.mjs`). `*/15 * * * *` purges expired D1 items, runs `maintain` for up to 4 minutes (which sweeps revocations) and compacts server logs. A cron that fires more often than hourly gets 30 s of CPU and 15 minutes of wall time; maintenance mostly waits on D1 and R2 |
| Migrations | `scripts/migrate.ts` over a remote D1 binding | `platforms/cloudflare/scripts/migrate.ts` | Run by the deploy after the code. The Worker has no admin surface. D1 schema changes are `migrations/*.sql`, applied before the code |
| Secrets | Worker secrets (`wrangler secret put`) | `platforms/cloudflare/src/env.ts` | `SESSION_SECRET`, `SITE_HMAC_KEY`, `SITE_SECRETS_KEY` and `OIDC_CLIENT_SECRET`, plus `GOOGLE_CLIENT_*` for a Google client. `setup.mjs` only ever adds them. `SITE_SECRETS_KEY` is never replaced |
| Sign-in | (core OIDC) | — | The client secrets are Worker secrets |

## 3. Edge and sites host

`src/sites.ts` calls `routeSiteRequest` inside the Worker:
- **Routes:** `CachedRouteTable` (KV, then D1).
- **Revocations:** read from KV.
- **HMAC:** the site HMAC key, from `node:crypto`.

It maps the decision onto the runtime:
- A rewrite is served from R2.
- Fling's own pages come from Static Assets: the 404 page, with `__APP_ORIGIN__` filled in and
  never cached; the review shell, revalidated on every use; and `robots.txt`.
- A response is returned as is.
- An invoke goes through the core's `runInvoke` to the version's isolate, in the run the route
  names. With servers off it answers as a missing page.

Every response carries the decision's headers (`X-Robots-Tag: noindex`, `Referrer-Policy` on share
hosts, `X-Fling-Version`), because the Worker sees the response, where a viewer-request function
cannot. Static Assets have `run_worker_first`, so a site's host never reaches the UI's assets.

**View counts.** A page's beacon posts to `/_fling-seen` on the site's host, which the decision
makes an invoke with no server. The Worker counts it in the isolate's `ViewCounter`, which is built
once with the deps, so views batch across the isolate's requests. After the response
(`ctx.waitUntil`) it writes them, at most every 10 seconds. Views an isolate still holds when it is
evicted are lost.

## 4. Domains and TLS

- The app host is a **Worker Custom Domain**. The first deploy creates its DNS record and
  certificate.
- The sites need a proxied wildcard record that you add by hand (`*.$SITES_DOMAIN AAAA 100::`,
  a placeholder that never receives traffic), plus the Worker route `*.$SITES_DOMAIN/*`, which
  the deploy renders.
- `$APP_HOST` and `$SITES_DOMAIN` may differ but must sit in one zone and share a registrable
  domain, for the `fling_site` cookie.
- **Certificate:** Universal SSL covers only `$ZONE` and `*.$ZONE`. A sites domain one level
  further down needs one of:
  - an Advanced Certificate or Total TLS (Advanced Certificate Manager, $10 a month);
  - a zone of its own, with the app on the apex.

## 5. Infrastructure as code

There is no Terraform. Two scripts and the rendered wrangler config own the infrastructure:

| Who | Owns |
|---|---|
| `scripts/setup.mjs` (once, idempotent, never deletes) | The D1 database, R2 bucket and KV namespace; the R2 lifecycle rule on `server-logs/`; the D1 schema; the Worker's secrets; the deploy config (`CF_DEPLOY_CONFIG`) |
| `scripts/render-config.mjs` | `dist/wrangler.jsonc`, from `wrangler.jsonc` (the committed template, which runs locally as is) plus the deploy config: the account, resource ids, routes, vars and crons. The `send_email`, `worker_loaders` and `ratelimits` bindings are kept only when `MAIL` or `SERVERS` asks for them |
| `scripts/deploy.mjs` | The Worker's code, config, assets, routes and crons; D1 schema migrations; data migrations |
| You, in the dashboard | The sites' wildcard DNS record, its certificate, and the Email Service sending domain |

`tests/deploy-config.test.ts` covers the deploy config's checks and rendering.

## 6. Deploy and local runtime

- **Deploy:** `deploy-cloudflare.yml` runs by hand, in the `cloudflare` environment, with
  `CF_DEPLOY_CONFIG`, `CLOUDFLARE_API_TOKEN` and `FLING_E2E_API_KEY`. It runs `scripts/deploy.mjs`,
  which:
  1. renders `dist/wrangler.jsonc`;
  2. builds the `.mcpb` with the instance's address;
  3. assembles `dist/assets` and checks the bundle (`build.mjs`: no AWS SDK, size limit);
  4. runs `wrangler d1 migrations apply --remote`;
  5. runs `wrangler deploy`;
  6. runs `migrate.ts --remote`;
  7. waits for `/.well-known/fling` to report the release;
  8. runs the e2e smoke test (`packages/e2e`).
- **Local runtime:** `scripts/dev.mjs` applies the local D1 schema and migrations, then runs
  `wrangler dev` on :47103 with local D1, R2, KV, Durable Objects, the simulated `send_email` and
  the local Worker Loader. It runs no crons; `POST /dev/notify/drain` drains the outbox. `pnpm e2e`
  runs it as the "cloudflare" runtime.
- **Emulators:** Miniflare runs every adapter suite in the gate, with no external services:
  - `tests/conformance.test.ts` covers D1, R2 and KV;
  - `tests/sites.test.ts` covers the cached route table;
  - `tests/live.test.ts` uses real WebSockets;
  - `tests/servers.test.ts` uses the real Worker Loader;
  - `tests/mail.test.ts` covers the mailer.

## 7. Capabilities

- Every capability can be on.
- `email`, `invites` and the email channel of notifications need `MAIL` in the deploy config, and
  a sending domain onboarded in Email Service on Cloudflare DNS.
- `servers` needs `INSTANCE.SERVERS` and the Worker Loader beta on the account.
- `serversEgress` follows `SERVERS_EGRESS`.
- `live` is on with the Durable Object hub at `wss://$APP_HOST/api/live`.

## 8. Gaps and open questions

- **Size.** Workers KV has no store limit that Fling meets, and D1 answers a miss, so the route
  table does not bound the number of sites. D1's 10 GB database is the ceiling, reached first by
  comments and form responses (hundreds of thousands of sites). The route format still applies:
  `compact` makes each KV value smaller.
- **Terraform.** Cloudflare has an official provider, `cloudflare/cloudflare`. Terraform could own:
  - the D1 database, R2 bucket and lifecycle rule, and KV namespace;
  - the wildcard DNS record and the Advanced Certificate;
  - the Workers route and Custom Domain;
  - the Email Service sending domain.

  The Worker's code, bindings, assets and crons could stay with wrangler and `deploy.mjs`, as
  `deploy.yml` owns the Lambda's code on AWS. Secrets would stay out of state either way. Open
  question: whether a `platforms/cloudflare/infra` module, versioned like the AWS one, should
  replace `setup.mjs`, or sit beside it for instances already managed in Terraform.
- **Beta dependencies.** The Worker Loader (site servers) and Email Service (mail) are in beta.
  If the Worker Loader's terms change, the fallback is Workers for Platforms (DEPLOY.md, Site
  servers).
- **Stale route reads.** A changed or deleted route can be served from KV for its propagation
  time. A rollback or a revoked share link is not instant at every location.
- **Watching maintenance and storage.** The Worker has Workers Logs on (`observability` in
  `wrangler.jsonc`), so its JSON log lines can be searched in the dashboard: **Workers & Pages →
  the Worker → Observability**, filtered on the message text. `maintenance lap` (with `lapMs`)
  is logged when maintenance has gone round every site, as on AWS (whose module saves Logs
  Insights queries for it, `platforms/aws/DEPLOY.md`, Saved queries); **Admin → Routes** shows
  the last lap. `route table usage` and `kvs write retried` are AWS lines: KV has no store limit
  Fling meets and no ETag to race for. KV's reads, writes and stored bytes are under **Storage &
  databases → KV → the namespace → Metrics**, and D1's rows read and written and its database size
  under **Storage & databases → D1 → the database → Metrics**. Workers Logs keeps events for days,
  not weeks, so note a lap's length if it is wanted later.

## 9. Sources

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1](https://developers.cloudflare.com/d1/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Workers KV: how KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
- [Durable Objects: WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Worker Loader (Dynamic Workers)](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
- [Email Service: Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [Advanced Certificate Manager](https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/)
- [Cloudflare Terraform provider](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs)
