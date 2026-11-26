# Self-hosting Fling (Docker Compose or Kubernetes)

**Ask your agent:**

```text
Clone https://github.com/nearform/fling and follow platforms/node/DEPLOY.md
to self-host Fling at fling.yourdomain.com with Docker Compose (or on my Kubernetes cluster).
Before you create or change anything, ask me for what you need
(the machine or cluster, the DNS provider, the sign-in provider) and show me the plan.
When it is live, tell me the host our Claude admin must allow for Claude's code execution
(the guide's "Claude's sandbox" section).
```

Or follow the steps below yourself.

> **After it is live:** have your Claude admin add the Fling's host (for example
> `fling.yourdomain.com`) to **Additional allowed domains** for Claude's code execution, on
> claude.ai under **Organization settings → Capabilities**. Without it, Claude can't upload the
> files it makes and stops to ask for it. See [Claude's sandbox](../aws/DEPLOY.md#claudes-sandbox-allow-your-flings-host).

How Fling works on machines you run, element by element:
[docs/platforms/digitalocean-self-host.md](../../docs/platforms/digitalocean-self-host.md).
DigitalOcean runs the same image on App Platform:
[platforms/digitalocean/DEPLOY.md](../digitalocean/DEPLOY.md).

Self-hosted, Fling is **one container image**, the Node host (`platforms/node/Dockerfile`), on a
Postgres and an S3-compatible object store, behind a TLS front for the app host and every site.
The image is the same for every instance: all of an instance's values are its environment. Two
ways to run it are kept here:

- **Docker Compose** (`deploy/compose/`), one machine: the image, Postgres, MinIO and Caddy, which
  gets a wildcard certificate from Let's Encrypt over ACME DNS-01.
- **Helm** (`deploy/helm/fling/`), Kubernetes: the image as a Deployment of several replicas
  behind an Ingress, on a Postgres and a store you provide.

The examples use these placeholders; substitute your own:

| Placeholder | Example | What |
| --- | --- | --- |
| `$APP_HOST` | `fling.example.com` | The app (UI and API) |
| `$SITES_DOMAIN` | `fling.example.com` | Sites hang off it: `<name>.$SITES_DOMAIN` (may equal `$APP_HOST`; must share its registrable domain) |
| `$STORAGE_HOST` | `fling-storage.example.com` | Compose only: the sites bucket in MinIO, path-style (`/<bucket>/<key>`), which the presigned upload and download URLs name; Caddy passes nothing else of MinIO's API. Outside `*.$SITES_DOMAIN`, or it hides the site of that name |

```
$APP_HOST        Caddy or the Ingress → the Node host ─┬─ /api/*, /auth/*, /mcp, /oauth/*,
                                                       │  /.well-known/*  → the API core
                                                       ├─ GET /api/live   → live rooms (WebSocket;
                                                       │                    fanned out over Postgres)
                                                       ├─ /blob-upload/*  → uploads a store bound
                                                       │                    by MD5 can't take
                                                       ├─ POST /ticks/*   → ticks and migrations
                                                       │                    (TICK_SECRET)
                                                       └─ everything else → the web UI
*.$SITES_DOMAIN  Caddy or the Ingress → the Node host ─── the shared site routing decision
                                                          (route table: Postgres, cached) →
                                                          the object store
$STORAGE_HOST    Caddy → MinIO ──── /<bucket>/* only ───── presigned PUTs and GETs (CLI, pull)
in process       every minute: the notifications' outbox → SMTP (with MAIL_DRIVER=smtp);
                 every 15 minutes: maintenance (retention, expired items, staged uploads)
```

## Requirements

- **Compose:** a Linux machine with Docker Engine and Compose v2.24 or later, ports 80 and 443
  open, and a DNS zone at a provider [Caddy has a DNS module for](https://github.com/caddy-dns)
  (Cloudflare, DigitalOcean, Route 53, Hetzner, Gandi, …), with an API token that may edit its
  TXT records.
- **Kubernetes:** a cluster with an Ingress controller (ingress-nginx, Traefik, …),
  [cert-manager](https://cert-manager.io/) with a ClusterIssuer that solves DNS-01 (a wildcard
  certificate needs DNS-01), a Postgres (a direct or session-mode connection, never a
  transaction-mode pooler) and an S3-compatible bucket with keys.
- **Both:** an OpenID Connect client for sign-in (Google, Microsoft Entra ID, Okta, …) with the
  redirect URI `https://$APP_HOST/auth/callback`; see
  [Sign-in](../aws/DEPLOY.md#sign-in-openid-connect). Optionally an SMTP relay for email.
- The image: build it from a checkout of a release tag (below), or pull one your organisation
  publishes. A release's image runs that release: `/.well-known/fling` reports it as `release`.

```bash
git checkout v0.14.0
docker build -f platforms/node/Dockerfile -t fling-node:0.14.0 \
  --build-arg FLING_MCPB_SERVER_URL=https://$APP_HOST .
```

`FLING_MCPB_SERVER_URL` bakes the instance into the Claude Desktop extension the web UI offers;
without it the extension asks for a server.

## Configuration

The Node host takes the instance configuration every platform takes
([Instance configuration](../aws/DEPLOY.md#instance-configuration): `INSTANCE_NAME`,
`ALLOWED_EMAIL_DOMAINS`, `ADMIN_EMAILS`, `OIDC_*`, `BRAND_*`, `MAIL_*`, …), the secrets every
platform keeps (`SESSION_SECRET`, `SITE_HMAC_KEY`, `OIDC_CLIENT_SECRET`, …;
[Secrets](../aws/DEPLOY.md#secrets)), and its own: the database, the store and the listener, in
[the Node host's table](README.md#running-it). Compose and the chart set the platform's part
(`APP_ORIGIN`, `SITES_DOMAIN`, `SITE_COOKIE_DOMAIN`, `LIVE_URL`, `DATABASE_URL`, `STORAGE_DRIVER=s3`
and `S3_*`, `APP_ENV=production`) from a few values; the instance's own part is yours.

Generate each secret once (`openssl rand -base64 32`) and keep it: a new `SESSION_SECRET` signs
everyone out, a new `SITE_HMAC_KEY` voids every share link.

Optional: rich previews of your Fling's links in Slack ([Link previews in Slack](#link-previews-in-slack)).

## Docker Compose

```bash
cd platforms/node/deploy/compose
cp .env.example .env              # addresses, secrets, the DNS provider
cp fling.env.example fling.env    # the instance: name, who may sign in, OIDC, mail
docker compose up -d --build      # or set FLING_IMAGE to a published image and drop --build
```

- **TLS.** Caddy is built with one [caddy-dns](https://github.com/caddy-dns) module,
  `CADDY_DNS_MODULE` (default `github.com/caddy-dns/cloudflare`), and obtains certificates for
  `$APP_HOST`, `*.$SITES_DOMAIN` and `$STORAGE_HOST` over ACME DNS-01 with `ACME_DNS_PROVIDER`
  and `ACME_DNS_API_TOKEN`. A provider whose module takes one token needs only `.env`
  (`cloudflare`, `digitalocean`, `hetzner`, …); others take more lines in `caddy/Caddyfile`, as
  their module's README says. Point `$APP_HOST`, `*.$SITES_DOMAIN` and `$STORAGE_HOST` at the
  machine.
- **On-demand TLS** (a certificate per site name, over HTTP-01, at its first request) avoids a DNS
  token, but Caddy then needs an `ask` endpoint that says which names are sites, which Fling does
  not offer; and every new site's first visitor waits for its certificate. Use DNS-01.
- **Storage.** MinIO keeps a private bucket (`FLING_BUCKET`, default `fling-sites`).
  `minio-init` creates it on every start, idempotently, with a lifecycle rule for chunked MCP
  uploads (`uploads/`, swept after a day) and the host's own key (`fling`, read and write on that
  bucket only). Staged uploads (`sites/<id>/_staged/`) are swept by the host's maintenance.
  Uploads are bound by `Content-MD5` (`S3_UPLOAD_DIGEST=md5`); a file whose MD5 an older CLI did
  not send goes through the host. Caddy passes only the bucket's path-style URLs
  (`/<bucket>/*`, so `S3_FORCE_PATH_STYLE=true`) to MinIO and answers 404 for the rest of its
  API, its admin routes included. Any other S3-compatible store works in MinIO's place: set
  `S3_*` in `fling.env` and drop the `minio` and `minio-init` services.
- **Ticks and migrations.** The host migrates the schema and the data on start and runs the ticks
  on timers in its process. `TICK_SECRET` opens `POST /ticks/notify`, `/ticks/maintain` and
  `/ticks/migrate` to an outside scheduler; every tick is safe to repeat.
- **Upgrading** to a release: rebuild from its tag (or change `FLING_IMAGE`) and
  `docker compose up -d`. The host migrates on start; each migration is written to serve before
  and after it runs.
- **Backups:** the `postgres-data` and `minio-data` volumes (`pg_dump`; `mc mirror`).

### Trying it on a laptop

`compose.local.yaml` runs the same services over plain HTTP on `lvh.me` (every name under it is
127.0.0.1), with dev login, the memory mailer and outside invitations on. `smoke.sh` brings it up,
runs the e2e scenario against it (`pnpm e2e attached`) and takes it down again:

```bash
pnpm install && pnpm build
platforms/node/deploy/compose/smoke.sh       # FLING_LOCAL_PORT=47380; FLING_SMOKE_KEEP=1 keeps it up
```

## Kubernetes (Helm)

```bash
kubectl create namespace fling
kubectl -n fling create secret generic fling \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 32)" \
  --from-literal=SITE_HMAC_KEY="$(openssl rand -base64 32)" \
  --from-literal=TICK_SECRET="$(openssl rand -base64 32)" \
  --from-literal=DATABASE_URL='postgres://fling:…@postgres:5432/fling' \
  --from-literal=S3_ACCESS_KEY_ID=… --from-literal=S3_SECRET_ACCESS_KEY=… \
  --from-literal=OIDC_CLIENT_SECRET=…
helm install fling platforms/node/deploy/helm/fling -n fling -f my-values.yaml
```

`values.yaml` documents every key. The ones every install sets:

```yaml
image: { repository: registry.example.com/fling-node, tag: 0.14.0 }
instance: { appHost: fling.example.com, sitesDomain: fling.example.com }
env:
  INSTANCE_NAME: Fling
  ALLOWED_EMAIL_DOMAINS: example.com
  OIDC_ISSUER: https://accounts.google.com
  OIDC_CLIENT_ID: …
storage:
  bucket: fling-sites
  endpoint: https://nyc3.digitaloceanspaces.com   # empty for AWS S3
  region: nyc3
secrets: { existingSecret: fling }
ingress:
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-dns01
    nginx.ingress.kubernetes.io/proxy-body-size: 32m
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
```

- **Replicas.** `replicaCount` (default 2) replicas share one Postgres: the live rooms fan out
  through `LISTEN`/`NOTIFY`, the Table's conditional writes keep them consistent. A rolling update
  keeps every replica serving until its successor is ready (`/healthz` probes, which answer on the
  pod's address).
- **Ingress and TLS.** One Ingress routes `$APP_HOST` and `*.$SITES_DOMAIN` to the Service; its
  TLS Secret (`ingress.tls.secretName`) holds a certificate for both, which cert-manager issues
  from the annotation. The Ingress must take request bodies of `maxRequestBytes` (32 MiB) and keep
  WebSockets open.
- **Ticks.** Every replica runs the ticks on timers in process; there are no CronJobs, since a
  tick is safe to repeat and a minute's schedule would add nothing but pods.
- **Migrations.** Each replica migrates on start, under a lock in Postgres. A Helm hook Job runs
  after every install and upgrade and calls `POST /ticks/migrate` on the Service until it reports
  done (with `TICK_SECRET` in the Secret; without one it says so and succeeds).
- **Site servers** are refused: the chart fails to render with `SERVERS` set to anything but
  `off`. Pods mount no service account token.
- **Storage.** The chart always uses the S3 store; `/data` is an `emptyDir` for scratch, and the
  root filesystem is read-only. The pods run as the image's unprivileged user.

## Site servers

Off. The Node host runs site servers as Node child processes, which isolate nothing from the host,
its secrets or each other, so keep `SERVERS` unset (the `servers` capability is off and clients
hide the feature). They need a sandboxed runtime (gVisor, Firecracker) that this platform does not
yet provide.

## Deleted sites

With `SITE_DELETE=soft`, the default, a deleted site's files stay where they were, with a recovery
file beside them: `sites/<siteId>/`, each of its Paths' `sites/<pathId>/`, and a `deleted.json` in
each. An admin restores one, or deletes it for good, on **Admin → Deleted** in the web app, from
their own browser session. What is kept, recovering a site by hand when a restore can't, the cost
and the known risks are in [Deleted sites](../aws/DEPLOY.md#deleted-sites) in the AWS guide; it is
the same here. So is the
[archive policy](../aws/DEPLOY.md#archive-policy), which can purge them `PURGE_DELETED_DAYS` after
their delete.

With Compose, the prefixes are in MinIO's bucket (`FLING_BUCKET`, default `fling-sites`); with
another S3-compatible store, in the bucket `SITES_BUCKET` names. With MinIO's client, from the
`minio-init` service or anywhere with an alias for it (`mc alias set local …` as root):
`mc find local/fling-sites/sites --name deleted.json` finds every recovery file,
`mc cat local/fling-sites/sites/<siteId>/deleted.json` reads one, and
`mc cp --recursive local/fling-sites/sites/<siteId>/<versionId>/ ./recovered` downloads a
version. With `STORAGE_DRIVER=fs` (one machine) they are directories under `FS_ROOT`
(`<FS_ROOT>/sites/<siteId>/`). The bucket's lifecycle rule touches only `uploads/`.

## Link previews in Slack

**Optional.** With a Slack app, a site's link posted in your workspace gets a rich preview when the
person who posted it can open the site. Create the app from
[docs/slack/manifest.yml](../../docs/slack/manifest.yml) and give the instance its two secrets,
`SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`, in its secret environment (the Compose env file, or
the Helm chart's secret values). See [Link previews in
Slack](../aws/DEPLOY.md#link-previews-in-slack) in the AWS guide for the steps.

## Claude's sandbox: allow your Fling's host

So that Claude can upload the files it makes with code execution rather than typing them out
again, your Claude admin adds your Fling's host (the host of the app's address) to **Additional
allowed domains**, on claude.ai in a web browser under **Organization settings → Capabilities →
Code execution and file creation**. Only that host is needed. See
[Claude's sandbox](../aws/DEPLOY.md#claudes-sandbox-allow-your-flings-host) in the AWS guide for
the steps and how to check them.

## Rollback

Run the previous release's image (`FLING_IMAGE`, or `image.tag` and `helm upgrade`). Every
release serves the data the next one wrote ([Data migrations](../aws/DEPLOY.md#data-migrations)).

Before rolling back to a release before 0.16.0, choose the `json` route format in Admin → Routes
and wait until its panel says the rewrite has finished: those releases read only `json` routes
([Route table size and format](../aws/DEPLOY.md#route-table-size-and-format)).

## Costs

Your machines. One small machine (2 vCPU, 2 GB) runs the Compose file for a team.
