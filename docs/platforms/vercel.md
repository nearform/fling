<!-- markdownlint-disable MD013 -->

# Platform: Vercel

How Fling would meet the [logical platform](../design/platform.md) on Vercel. There is no deploy
guide yet.

## 1. Status and shape

**Status:** proposed.

**Shape:** edge function, like AWS.
- Vercel Routing Middleware runs JS before the cache, so `routeSiteRequest` runs there against
  an edge key-value store, then rewrites to object storage.
- The API runs as Vercel Functions (Node, Fluid compute) through Hono's Vercel adapter.

**Cost floor:** a Pro team seat, plus usage of Functions, Global Config, Blob and a Marketplace
Postgres. Most of these are billed through Vercel, but some are third parties.

**Effort:** medium. It is fast to stand up, but Vercel leans on third parties more than any
other target: Postgres from the Marketplace, live rooms from a WebSocket service, and mail from a
provider. The route table also has write limits that a busy instance reaches.

## 2. Mapping

| Element | Vercel service | Adapter (proposed) | Notes |
|---|---|---|---|
| Table | Marketplace Postgres (Neon) | the shared Postgres adapter ([platform §5](../design/platform.md#5-shared-building-blocks-for-new-platforms)) | Connected through Neon's serverless driver or a pooled connection, because Functions are short-lived |
| Blobs | Vercel Blob, or any S3-compatible store | `platforms/vercel/src/blobs/vercel-blob.ts`, or `S3Blobs` | Vercel Blob uploads from the client with a short-lived token. Whether a token can bind the upload to its SHA-256 is unconfirmed (§8); see [the upload binding](../design/platform.md#6-known-gaps-in-the-contract). An S3-compatible store keeps `S3Blobs` |
| Route table | Global Config (formerly Edge Config), or Marketplace Redis (Upstash) | `platforms/vercel/src/route-table/global-config.ts` or `…/redis.ts` | Global Config is read at the edge with almost no latency, but it allows 1 MB per store and, on Pro, 100 writes an hour. Every publish, share link and revocation is a write, so Redis is the safer default |
| Sites host | Routing Middleware | `platforms/vercel/src/middleware.ts` | See §3 |
| Live hub | None (Functions do not hold WebSockets) | a hub over a third-party WebSocket service (Ably, Pusher), or off | `publish` becomes the provider's REST publish to a per-site channel, and the ticket check moves to the provider's token auth |
| Mailer | None on Vercel | the shared HTTP mailer ([platform §5](../design/platform.md#5-shared-building-blocks-for-new-platforms)) | |
| Site servers | Vercel Sandbox (Firecracker microVMs) | `platforms/vercel/src/servers/` | The closest isolation primitive. Whether its start time and cost suit a server per site is open (§8) |
| Server logs | Written by the runner to Blob | `platforms/vercel/src/servers/server-logs.ts` | |
| Ticks | Vercel Cron Jobs calling a Function | `platforms/vercel/src/ticks.ts` | Calls carry `CRON_SECRET`. Whether a per-minute schedule is allowed depends on the plan (§8) |
| Migrations | A Function called by the deploy | `platforms/vercel/src/migrate.ts` | Looped until done, within the Function's maximum duration |
| Secrets | Project environment variables (sensitive) | environment, through `secretsFromEnv` | |
| Sign-in | (core OIDC) | — | The client secrets are environment variables |

## 3. Edge and sites host

The middleware matches `*.<sites domain>`. It calls `routeSiteRequest` with lookups against the
route table and Web Crypto HMAC:
- A rewrite goes to the object's URL in Blob (or the S3 store), proxied through the project.
- A response is returned from the middleware.
- An invoke goes to the site's sandbox with the viewer and site headers.

As on AWS, headers on rewritten objects need checking, because middleware may not set response
headers on a rewrite to an outside origin. The middleware bundle has a size limit, which the
decision fits easily.

## 4. Domains and TLS

- Vercel issues certificates automatically for the app domain and for `*.<sites domain>`.
- A wildcard domain requires the zone to use Vercel's nameservers, so the operator moves the
  sites domain's DNS (or a delegated subdomain) to Vercel.

## 5. Infrastructure as code

The official `vercel/vercel` Terraform provider manages:
- the project and its domains, the wildcard included;
- environment variables;
- the Global Config store.

Marketplace resources (Neon, Upstash) are created through their own integrations or providers.
The module would be `platforms/vercel/infra`, versioned like the AWS one.

## 6. Deploy and local runtime

- **Deploy:** a `deploy-vercel.yml` workflow. In order, it:
  1. runs `vercel build` and `vercel deploy --prebuilt` with a team token kept as a GitHub
     secret;
  2. calls `migrate`;
  3. polls `/.well-known/fling`;
  4. runs the e2e smoke test.

  Vercel can trust GitHub OIDC for its own cloud integrations, but deploys still need a token.
- **Local runtime:** the middleware and Functions under `vercel dev`, or the Node host with the
  same adapters. Postgres and Redis run locally.
- **Emulators:** Postgres and Redis in CI. Vercel Blob has no emulator, so the S3 variant runs on
  MinIO.

## 7. Capabilities

- `live` is off unless a third-party WebSocket hub is configured.
- `servers` is off until the Sandbox runner exists.
- `email` needs an HTTP mailer provider.
- Every other capability can be on.

## 8. Gaps and open questions

- **Route table write rate.** Pro allows 100 Global Config writes an hour. Does that hold under
  publishing load, or is Redis required
  ([Global Config limits](https://vercel.com/docs/global-config/global-config-limits))?
- **Blob and SHA-256.** Can a client-upload token bind the bytes' SHA-256?
  ([Vercel Blob](https://vercel.com/docs/vercel-blob))
- **Cron frequency.** Per-minute Cron Jobs depend on the plan
  ([Cron Jobs](https://vercel.com/docs/cron-jobs)).
- **Sandbox as site servers.** Start time, limits and cost per site, and how to fence egress
  ([Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)).
- **Hosting terms.** Does serving arbitrary users' sites from one project fit Vercel's fair use
  for the plan?

## 9. Sources

- [Routing Middleware](https://vercel.com/docs/routing-middleware)
- [Edge Config is now Global Config](https://vercel.com/changelog/edge-config-is-now-global-config)
- [Global Config limits](https://vercel.com/docs/global-config/global-config-limits)
- [Vercel Functions](https://vercel.com/docs/functions)
- [Vercel Blob](https://vercel.com/docs/vercel-blob)
- [Cron Jobs](https://vercel.com/docs/cron-jobs)
- [Vercel Terraform provider](https://registry.terraform.io/providers/vercel/vercel/latest/docs)
