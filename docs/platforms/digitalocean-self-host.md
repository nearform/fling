<!-- markdownlint-disable MD013 -->

# Platform: DigitalOcean and self-host

How Fling meets the [logical platform](../design/platform.md) on DigitalOcean, and on machines the
operator runs. Both run the same container, the **Node host image**, on the same adapters; only the
infrastructure around it differs. Deploy guides:
[DigitalOcean](../../platforms/digitalocean/DEPLOY.md) and
[self-host](../../platforms/node/DEPLOY.md).

## 1. Status and shape

**Status:** supported.

**Shape:** one host that routes. The
[Node host](../design/platform.md#5-shared-building-blocks-for-new-platforms) runs as one
container image (`platforms/node/Dockerfile`) serving:
- the app host;
- the sites host;
- the host's upload routes, for files a store bound by MD5 can't take directly;
- the live rooms.

It sits behind a TLS front that only terminates TLS:
- **DigitalOcean:** App Platform's ingress, with its Let's Encrypt certificates;
- **Docker Compose:** Caddy;
- **Kubernetes:** the cluster's Ingress controller, with cert-manager.

**Cost floor:**
- **DigitalOcean:** one small App Platform container, the smallest Managed PostgreSQL cluster, and
  Spaces (one flat monthly price with storage and transfer included).
- **Self-host:** the operator's own machines.

## 2. Mapping

| Element | DigitalOcean | Self-host | Adapter | Notes |
|---|---|---|---|---|
| Table | Managed PostgreSQL, a direct connection, TLS verified against the cluster's CA (`DATABASE_CA_CERT`) | PostgreSQL | the shared Postgres Table (`platforms/node/src/table/postgres.ts`) | Never a pool in transaction mode ([platform §5](../design/platform.md#5-shared-building-blocks-for-new-platforms)) |
| Blobs | Spaces | MinIO in the Compose file; any S3-compatible store | `S3Blobs` (`platforms/s3/src/blobs.ts`) from the environment (`s3FromEnv`, `platforms/s3/src/env.ts`) | Bound by `Content-MD5` (`S3_UPLOAD_DIGEST=md5`), with the host's upload routes for a file sent without one (§8). MinIO passes `blobsConformance` in CI binding either digest |
| Route table | Postgres, with an in-process cache | the same | `CachedRouteTable` (`platforms/node/src/route-table/cached.ts`) over `TableRouteTable` | |
| Sites host | The Node host | the same | `platforms/node` | See §3 |
| Live hub | WebSockets on the Node host | the same | the Node host's hub, with the Postgres `LISTEN`/`NOTIFY` fan-out (`platforms/node/src/live/postgres-fanout.ts`) | Several replicas share their rooms through Postgres |
| Mailer | an SMTP provider (DigitalOcean sends no mail) | the operator's SMTP relay | `SmtpMailer` (`platforms/node/src/mail/smtp.ts`) | `MAIL_DRIVER=smtp` |
| Site servers | off | off | — | The Node host's child processes isolate nothing; §7 |
| Server logs | — | — | — | With site servers |
| Ticks | the Node host's in-process timers | the same | `platforms/node/src/main.ts` | App Platform's scheduled jobs run at most every 15 minutes. Every tick is safe to repeat, so every replica runs them; `POST /ticks/*` with `TICK_SECRET` takes an outside scheduler too |
| Migrations | on start, then `POST /ticks/migrate` from the deploy workflow until done | on start; the Helm chart's post-upgrade hook Job calls `POST /ticks/migrate` | `runMigrations` | Schema migrations run under a Postgres lock, so replicas starting together apply each once |
| Secrets | App Platform's encrypted environment variables (`SECRET`) | a `.env` file (Compose) or a Kubernetes Secret | `secretsFromEnv` | On DigitalOcean the Terraform state holds them (§8) |
| Sign-in | (core OIDC) | (core OIDC) | — | |

## 3. Edge and sites host

The front only terminates TLS. The Node host makes the routing decision for every site request and
reads the object from Spaces or MinIO with the decision's headers. `/healthz` answers on any host
that is neither the app's nor a site's, so App Platform's, Docker's and Kubernetes' probes reach
it at the container's address. Spaces' CDN stays off: it can't make the routing decision, and the
bucket is private.

## 4. Domains and TLS

- **DigitalOcean:** the app host and `*.<sites domain>` are App Platform domains, the sites one a
  wildcard. With the zone on DigitalOcean DNS, App Platform keeps the records and issues and
  renews the Let's Encrypt certificates, the wildcard included (it verifies the wildcard with TXT
  records in the zone).
- **Docker Compose:** Caddy obtains certificates for the app host, `*.<sites domain>` and the
  storage host over ACME DNS-01, with a [caddy-dns](https://github.com/caddy-dns) module for the
  operator's DNS provider built in. On-demand TLS is not used: it needs an `ask` endpoint naming
  the sites, which Fling does not offer.
- **Kubernetes:** one Ingress for the app host and `*.<sites domain>`; cert-manager fills its TLS
  Secret through a DNS-01 ClusterIssuer.

## 5. Infrastructure as code

- **DigitalOcean:** the Terraform module `platforms/digitalocean/infra` (provider
  `digitalocean/digitalocean`) makes the App Platform app, the PostgreSQL cluster and its
  firewall, the Spaces bucket with its lifecycle and key, and the domains. Terraform owns the
  shape; the deploy workflow owns the image tag.
- **Self-host:** a Docker Compose file (`platforms/node/deploy/compose/`: the image, Postgres,
  MinIO with its bucket set up by `minio-init`, Caddy) for one machine, and a Helm chart
  (`platforms/node/deploy/helm/fling/`) for Kubernetes.

## 6. Deploy and local runtime

- **Image:** `platforms/node/Dockerfile`, built from a release tag; it reports that release in
  `/.well-known/fling`.
- **DigitalOcean:** the **Deploy (DigitalOcean)** workflow (`deploy-digitalocean.yml`, by hand,
  with a release tag) builds the image, pushes it to the account's container registry, points the
  app at it and waits for the deployment, polls `/.well-known/fling` for the release, runs
  `POST /ticks/migrate` until done and then the e2e smoke test. DigitalOcean has no OIDC for
  GitHub, so it signs in with a scoped API token kept as an environment secret.
- **Self-host:** operators build or pull the image and `docker compose up` or `helm upgrade`.
- **Local runtime:** the Node host is the e2e's `node` runtime in every gate (PGlite, fs blobs).
  The Compose file itself runs the scenario through `platforms/node/deploy/compose/smoke.sh`
  (HTTP on `lvh.me`, dev login; `pnpm e2e attached`), on a machine with Docker.
- **Emulators:** none needed. Postgres and MinIO are the real services, and both run in CI.

## 7. Capabilities

- Every capability can be on except `servers` (and so `serversEgress`): `SERVERS` stays off.
  Running untrusted site servers needs a sandboxed runtime (gVisor, Firecracker), which App
  Platform does not offer and the self-host files do not set up.
- `email` and `notifications` by email need an SMTP provider (`MAIL_DRIVER=smtp`).
- `live` is on wherever `LIVE_URL` is set: Compose, the chart and the module set it to
  `wss://<app host>/api/live`.

## 8. Gaps and open questions

- **Spaces and SHA-256.** Whether a presigned PUT with a signed `x-amz-checksum-sha256` rejects
  other bytes on Spaces is unconfirmed, so uploads there are bound by `Content-MD5`
  (`S3_UPLOAD_DIGEST=md5`): each staged file is copied into the version and checked before it goes
  live, which reads every uploaded byte once more. Running `blobsConformance` against a Spaces
  bucket would settle it.
- **Secrets in Terraform state.** The App Platform spec has no write-only attributes, so the
  generated secrets the module sets on the app are in its state: keep the state in an encrypted
  backend with restricted access.
- **A sandbox for site servers.** gVisor and Firecracker each need a host that supports them
  (a Droplet, or a DOKS node pool with the runtime class), and an adapter for them in
  `platforms/node`.
- **The objects are whole reads.** The Node host reads a site file whole from the store
  ([platform §6](../design/platform.md#6-known-gaps-in-the-contract)).
- **Unverified live.** The module is checked by `terraform validate` and `terraform test` against
  mocked providers, and the workflow has not yet deployed an instance.

## 9. Sources

- [DigitalOcean App Platform](https://docs.digitalocean.com/products/app-platform/)
- [App Platform: managing domains (wildcards)](https://docs.digitalocean.com/products/app-platform/how-to/manage-domains/)
- [App Platform: jobs](https://docs.digitalocean.com/products/app-platform/how-to/manage-jobs/)
- [DigitalOcean Managed PostgreSQL](https://docs.digitalocean.com/products/databases/postgresql/)
- [DigitalOcean Spaces](https://docs.digitalocean.com/products/spaces/)
- [DigitalOcean Terraform provider](https://registry.terraform.io/providers/digitalocean/digitalocean/latest/docs)
- [MinIO](https://min.io/docs/minio/linux/index.html)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [caddy-dns modules](https://github.com/caddy-dns)
- [cert-manager DNS-01](https://cert-manager.io/docs/configuration/acme/dns01/)
- [gVisor](https://gvisor.dev/docs/)
