<!-- markdownlint-disable MD013 -->

# Platform: DigitalOcean and self-host

How Fling would meet the [logical platform](../design/platform.md) on DigitalOcean, or on
machines the operator runs. Both variants run the same container on the same adapters. Only the
infrastructure around it differs. There is no deploy guide yet.

## 1. Status and shape

**Status:** proposed.

**Shape:** one host that routes. The
[Node host](../design/platform.md#5-shared-building-blocks-for-new-platforms) runs as one
container serving:
- the app host;
- the sites host;
- the signed blob routes;
- the live rooms.

It sits behind a TLS front: DO's load balancer or App Platform ingress, or Caddy or Traefik when
self-hosted.

**Cost floor:**
- **DigitalOcean:** one small App Platform container or Droplet, the smallest Managed Postgres,
  and Spaces (one flat monthly price with storage and transfer included).
- **Self-host:** the operator's own machines.

**Effort:** low once the Node host and the Postgres `Table` adapter exist. Self-host needs nothing
Fling's CI does not already run: Postgres and MinIO.

## 2. Mapping

| Element | DigitalOcean | Self-host | Adapter (proposed) | Notes |
|---|---|---|---|---|
| Table | Managed PostgreSQL | PostgreSQL | the shared Postgres adapter ([platform §5](../design/platform.md#5-shared-building-blocks-for-new-platforms)) | |
| Blobs | Spaces (S3-compatible) | MinIO, or any S3-compatible store | `S3Blobs` (`platforms/aws/src/blobs/s3.ts`) with an endpoint | MinIO already passes `blobsConformance` in CI. Whether Spaces enforces `x-amz-checksum-sha256` is unconfirmed (§8); see [the upload binding](../design/platform.md#6-known-gaps-in-the-contract) |
| Route table | Postgres, with an in-process cache | the same | `TableRouteTable` behind a cache, as `CachedRouteTable` does | |
| Sites host | The Node host | the same | `platforms/node` | See §3 |
| Live hub | WebSockets on the Node host | the same | `platforms/node` hub, with a Postgres `LISTEN`/`NOTIFY` fan-out | One container needs no fan-out |
| Mailer | None on DigitalOcean | the operator's SMTP relay | the shared HTTP or SMTP mailer ([platform §5](../design/platform.md#5-shared-building-blocks-for-new-platforms)) | |
| Site servers | App Platform components or DOKS pods per site | containers under gVisor or Firecracker, or off | `platforms/node/src/servers/container.ts` (proposed) | Plain containers do not isolate untrusted code well enough. A sandboxed runtime is required, or `SERVERS` stays off |
| Server logs | Written by the runner to the object store | the same | as on Fly | |
| Ticks | No per-minute scheduler confirmed | cron, or a Kubernetes `CronJob` | an in-process timer in the Node host with a Table lease | The lease lets every replica run the timer while one acts |
| Migrations | An App Platform pre-deploy job | an init container, or a one-off `docker compose run` | `platforms/node` migrate entry | Looped until done |
| Secrets | App Platform encrypted environment variables | Docker or Kubernetes secrets | environment, through `secretsFromEnv` | |
| Sign-in | (core OIDC) | (core OIDC) | — | |

## 3. Edge and sites host

The front only terminates TLS. The Node host makes the routing decision for every site request and
streams the object from Spaces or MinIO with the decision's headers. Spaces has a CDN, but the
CDN cannot make the decision. It can cache only what the Node host marks as public and immutable,
in front of the host and not in place of it.

## 4. Domains and TLS

- **DigitalOcean:** DO issues Let's Encrypt certificates for its load balancers and App Platform,
  wildcards included, when the domain's DNS is on DigitalOcean.
- **Self-host:** Caddy or Traefik obtains `*.<sites domain>` over ACME DNS-01, with a plugin for
  the operator's DNS provider.

## 5. Infrastructure as code

- **DigitalOcean:** the official `digitalocean/digitalocean` Terraform provider covers:
  - the App Platform app (or Droplets and DOKS);
  - the Postgres cluster;
  - the Spaces bucket and keys;
  - domains and certificates.

  The module would be `platforms/digitalocean/infra`, versioned like the AWS one.
- **Self-host:** a Docker Compose file (Node host, Postgres, MinIO, Caddy) for one machine, and a
  Helm chart for Kubernetes. Both live under `platforms/self-host/`.

## 6. Deploy and local runtime

- **Deploy:** one image is published per release (to GHCR).
  - On DigitalOcean, a workflow points the app at the new image tag with a DO API token, then
    runs the migrate job, polls `/.well-known/fling` and runs the e2e smoke test.
  - Self-hosters pull the tag.
- **Local runtime:** the Compose file itself, added to `packages/e2e/src/local.ts`.
- **Emulators:** none needed. Postgres and MinIO are the real services, and both run in CI.

## 7. Capabilities

- Every capability can be on, except that `servers` needs a sandboxed container runtime.
- `serversEgress` can be fenced with network policy (Kubernetes) or an internal Docker network.

## 8. Gaps and open questions

- **Spaces and SHA-256.** Does a presigned PUT with a signed `x-amz-checksum-sha256` reject
  different bytes? ([Spaces](https://docs.digitalocean.com/products/spaces/))
- **Ticks on App Platform.** App Platform jobs are not confirmed to run on a schedule, so the
  in-process timer is the plan
  ([App Platform jobs](https://docs.digitalocean.com/products/app-platform/)).
- **A sandbox for site servers.** gVisor and Firecracker each need a host that supports them, and
  App Platform does not offer one.
- **One image for every Node platform.** The same image serving Fly.io and DigitalOcean is the
  aim, but each platform's needs (release commands, health checks) must fit one entry point.

## 9. Sources

- [DigitalOcean App Platform](https://docs.digitalocean.com/products/app-platform/)
- [DigitalOcean Managed PostgreSQL](https://docs.digitalocean.com/products/databases/postgresql/)
- [DigitalOcean Spaces](https://docs.digitalocean.com/products/spaces/)
- [DigitalOcean Terraform provider](https://registry.terraform.io/providers/digitalocean/digitalocean/latest/docs)
- [MinIO](https://min.io/docs/minio/linux/index.html)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [gVisor](https://gvisor.dev/docs/)
