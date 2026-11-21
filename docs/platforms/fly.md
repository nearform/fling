<!-- markdownlint-disable MD013 -->

# Platform: Fly.io

How Fling would meet the [logical platform](../design/platform.md) on Fly.io. There is no deploy
guide yet.

## 1. Status and shape

**Status:** proposed.

**Shape:** one host that routes. The
[Node host](../design/platform.md#5-shared-building-blocks-for-new-platforms) runs as a Fly app
on Machines, behind Fly's anycast proxy. One process serves:
- the app host (the API and UI);
- the sites host, running `routeSiteRequest` and streaming from Tigris;
- the signed blob routes;
- the live rooms' WebSockets.

The app can run in one region or several.

**Cost floor:** low. The floor is a small always-on Machine, the smallest Managed Postgres plan,
and Tigris billed by use, all on the Fly invoice.

**Effort:** low once the Node host and the Postgres `Table` adapter exist. Fly supplies little
beyond them, so most of the work is setup and deploy scripts.

## 2. Mapping

| Element | Fly.io service | Adapter (proposed) | Notes |
|---|---|---|---|
| Table | Fly Managed Postgres | the shared Postgres adapter ([platform §5](../design/platform.md#5-shared-building-blocks-for-new-platforms)) | Postgres gives cross-partition transactions and byte order (`COLLATE "C"`). SQLite on a volume with LiteFS would also meet the contract, but it ties writes to one primary Machine and adds replication to operate, so Postgres is the recommendation |
| Blobs | Tigris (S3-compatible, globally replicated) | `S3Blobs` (`platforms/aws/src/blobs/s3.ts`) pointed at Tigris, if it passes `blobsConformance` | `fly storage create` makes the bucket and sets its credentials as app secrets. Whether Tigris enforces a signed `x-amz-checksum-sha256` on a presigned PUT is unconfirmed (§8). Without it, see [the upload binding](../design/platform.md#6-known-gaps-in-the-contract) |
| Route table | Postgres, with an in-process cache | the shared `CachedRouteTable` (`platforms/node/src/route-table/cached.ts`) over the core's `TableRouteTable` | A new key is visible at once. Changed keys are stale for up to the cache's lifetime (5 s) on other Machines |
| Sites host | The Node host | `platforms/node` | See §3 |
| Live hub | WebSockets on the Node host | the Node host's hub with the shared Postgres fan-out (`platforms/node/src/live/postgres-fanout.ts`) | WebSockets work natively through Fly's proxy. With more than one Machine, every room event reaches the other Machines through `NOTIFY` on the instance's channel, without another service |
| Mailer | None on Fly | the shared SMTP mailer ([platform §5](../design/platform.md#5-shared-building-blocks-for-new-platforms)) | A transactional provider's SMTP |
| Site servers | Fly Machines, one per site, created through the Machines API | `platforms/fly/src/servers/` | A generic runner image loads the version's `_fling/server.mjs` from Tigris. Machines stop when idle and start on request through the proxy. Each version is a Machine update, so `goLive` is the route's `t` changing |
| Server logs | Fly log shipping, or a log written by the runner | `platforms/fly/src/servers/server-logs.ts` | The simplest is the runner writing its lines to Tigris, as the Cloudflare isolate writes to R2 |
| Ticks | No managed per-minute scheduler | the Node host's in-process timers (`platforms/node/src/main.ts`) | Every Machine runs them; each tick is safe to repeat, as the outbox and the migration leases are conditional writes. Scheduled Machines run hourly at most, so they could serve `maintain` but not `notify` |
| Migrations | A release command (`[deploy] release_command` in `fly.toml`) | `POST /ticks/migrate` on the Node host, or its start (`src/main.ts` migrates on start) | Runs before the new Machines take traffic. The deploy loops it until done |
| Secrets | Fly secrets (`fly secrets set`) | environment, through `secretsFromEnv` | Encrypted at rest and injected as environment variables |
| Sign-in | (core OIDC) | — | The client secrets are Fly secrets |

## 3. Edge and sites host

Fly's proxy only terminates TLS and balances load; it runs no code. The Node host makes the
routing decision for every site request. It answers a rewrite by streaming the object from Tigris
with the decision's headers, so unlike AWS every response carries them. An invoke goes to the
site's Machine over Fly's private network (`<app>.internal` or `.flycast`), with the viewer and
site headers.

## 4. Domains and TLS

- `fly certs add <app host>` and `fly certs add "*.<sites domain>"` issue the certificates.
- The wildcard is validated by DNS-01: the operator adds the `_acme-challenge` CNAME that Fly
  names.
- A wildcard certificate also covers its non-wildcard name (Fly, January 2026), so one may serve
  when the sites domain equals the app domain.
- DNS stays with the operator's provider and points both names at the app's anycast addresses.

## 5. Infrastructure as code

Fly's Terraform provider (`fly-apps/terraform-provider-fly`) was archived on 1 March 2024, and
Fly does not recommend it. The infrastructure is therefore scripted, as on Cloudflare:
- `platforms/fly/fly.toml` describes the app: services, the release command and Machine sizes.
- `platforms/fly/scripts/setup.mjs` creates, once:
  - the app;
  - the Postgres cluster;
  - the Tigris bucket;
  - the certificates;
  - the secrets;
  - the deploy token.
- `platforms/fly/scripts/deploy.mjs` builds and deploys.

Terraform is used only for DNS, wherever the operator's DNS provider has one.

## 6. Deploy and local runtime

- **Deploy:** a `deploy-fly.yml` workflow. Fly has no GitHub OIDC trust, so the workflow uses a
  deploy token scoped to the app, kept as a GitHub secret. In order, it:
  1. builds one image (the Node host, the UI, the sites' own pages);
  2. runs `fly deploy`;
  3. runs the release command (`migrate`);
  4. polls `/.well-known/fling`;
  5. runs the e2e smoke test.
- **Local runtime:** the Node host over a local Postgres and MinIO, added to
  `packages/e2e/src/local.ts`.
- **Emulators:** Postgres and MinIO in CI. MinIO is already there for `S3Blobs`.

## 7. Capabilities

- Every capability can be on.
- `live` needs the fan-out once there is more than one Machine.
- `servers` needs the Machines runner.
- `serversEgress` stays on until an egress fence exists (§8).
- `email` needs an SMTP provider.

## 8. Gaps and open questions

- **Tigris and SHA-256.** Does a presigned PUT signed with `x-amz-checksum-sha256` reject
  different bytes? Run `blobsConformance` against Tigris to find out
  ([Tigris docs](https://www.tigrisdata.com/docs/), [SigV4 on Tigris](https://www.tigrisdata.com/blog/sigv4)).
- **Egress fence for site servers.** Fly Machines reach the internet by default. Fencing a site's
  Machine to "nothing outside" needs egress controls that are still unconfirmed. Until they
  exist, `SERVERS_EGRESS` stays `open`
  ([Fly private networking](https://fly.io/docs/networking/private-networking/)).
- **Isolation between site Machines.** Each site's Machine must be unable to reach the Fling app
  or another site over the private network. This needs a separate app per site, or a separate
  network ([Machines API](https://fly.io/docs/machines/api/)).
- **Managed Postgres features.** The current state of Fly Managed Postgres needs checking: plans,
  connection limits, and `LISTEN`/`NOTIFY` through its pooler
  ([Managed Postgres](https://fly.io/docs/mpg/)).

## 9. Sources

- [Fly.io docs](https://fly.io/docs/)
- [Machines API](https://fly.io/docs/machines/api/)
- [Object storage (Tigris)](https://fly.io/docs/tigris/)
- [Databases and storage](https://fly.io/docs/database-storage-guides)
- [Fly changelog](https://fly.io/changelog/)
- [terraform-provider-fly (archived)](https://github.com/fly-apps/terraform-provider-fly)
