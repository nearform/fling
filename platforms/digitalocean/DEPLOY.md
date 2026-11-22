# Deploying Fling on DigitalOcean

**Ask your agent:**

```text
Clone https://github.com/nearform/fling and follow platforms/digitalocean/DEPLOY.md
to install Fling on my DigitalOcean account at fling.yourdomain.com.
Before you create or change anything, ask me for what you need
(the DigitalOcean team and domain, the region, and the sign-in provider) and show me the plan.
```

Or follow the steps below yourself.

How Fling works on DigitalOcean, element by element:
[docs/platforms/digitalocean-self-host.md](../../docs/platforms/digitalocean-self-host.md).

Fling runs on DigitalOcean as **one App Platform app** running the Node host image
(`platforms/node/Dockerfile`), with its Table in **Managed PostgreSQL** and its site files in a
private **Spaces** bucket. The Terraform module (`infra/`) makes all of it once; the
`Deploy (DigitalOcean)` workflow ships each release. One deployment is an **instance**: its own
hostnames, sign-in allowlist, name and look, all configuration, none of it in the code.

The examples use these placeholders; substitute your own:

| Placeholder | Example | What |
| --- | --- | --- |
| `$ZONE` | `example.com` | Your domain, on DigitalOcean DNS (Networking → Domains) |
| `$APP_HOST` | `fling.example.com` | The app (UI + API) |
| `$SITES_DOMAIN` | `fling.example.com` | Sites hang off it: `<name>.$SITES_DOMAIN` (may equal `$APP_HOST`; must sit under the app's registrable domain) |
| `$REGION` | `ams3` | The datacentre of the database and the bucket; the app runs in the same region |
| `$REGISTRY` | `example-registry` | The account's container registry |

```
$APP_HOST, *.$SITES_DOMAIN   App Platform (TLS: Let's Encrypt, wildcard) ── the Node host
                             containers (instance_count), routing by host:
  $APP_HOST                  /api/*, /auth/*, /healthz, /mcp, /oauth/*, /.well-known/*
                             → the API core; GET /api/live → live rooms (WebSocket);
                             /blob-upload/* → the host's upload route (older CLIs);
                             /ticks/* → ticks and migrations (TICK_SECRET);
                             everything else → the web UI
  *.$SITES_DOMAIN            the shared site routing decision (route table in Postgres,
                             cached per container) → the file from Spaces
in each container            notifications every minute (with mail), maintenance every 15 min
Managed PostgreSQL           the Table, and the live rooms' LISTEN/NOTIFY fan-out
Spaces <name>-sites          site files; clients upload and download with presigned URLs
```

The sites host runs the same routing function as the AWS CloudFront Function and the Cloudflare
Worker (`packages/shared/src/site-routing.ts`).

## Requirements

- **A DigitalOcean team** with App Platform, Managed Databases, Spaces and the Container Registry.
- **The domain on DigitalOcean DNS** (`dns_zone`). App Platform then adds the records for
  `$APP_HOST` and `*.$SITES_DOMAIN` and obtains their Let's Encrypt certificates, the wildcard
  included. With DNS elsewhere, leave `dns_zone` unset: the module's `dns` output lists the
  CNAMEs to add, and the control panel (the app → Settings → Domains) shows the TXT records the
  wildcard certificate needs, which must be renewed when DigitalOcean asks.
- **The sites domain must be under the app's registrable domain**: the app sets the `fling_site`
  cookie, which lets members open private sites, on the domain both share
  (`SITE_COOKIE_DOMAIN`, default the sites domain).
- **Three credentials for Terraform**: an API token (`DIGITALOCEAN_TOKEN`), and a Spaces key
  (`SPACES_ACCESS_KEY_ID`, `SPACES_SECRET_ACCESS_KEY`; API → Spaces Keys, full access), which the
  provider needs to manage buckets. The module makes the app its own key, limited to the bucket.
- Terraform 1.11 or later, Docker, `doctl`, Node 24 and pnpm (the repository's).

## Infrastructure: the Terraform module

`platforms/digitalocean/infra` makes:

| Resource | What |
| --- | --- |
| `digitalocean_app` | The app: one service, `fling`, from `<registry>/fling-node:<tag>`, port 8080, health check `/healthz`; the domains; the environment; alerts for failed deploys and domains. The edge cache is off: it keys on the URL alone, and a site's URL serves whichever version is live |
| `digitalocean_database_cluster` | Postgres (`postgres_version`, default 17), with a `fling` database and user. Its firewall trusts the app alone |
| `digitalocean_spaces_bucket` | The private sites bucket (no CDN), with a lifecycle rule that deletes leftovers of chunked MCP uploads (`uploads/`) after a day |
| `digitalocean_spaces_key` | The app's key: read and write on that bucket only |
| `digitalocean_container_registry` | The registry, unless `create_registry = false` (an account has one) |
| `random_password` × 3 | `SESSION_SECRET`, `SITE_HMAC_KEY` and `TICK_SECRET` |

Its inputs:

| Variable | Default | What |
| --- | --- | --- |
| `name` | `fling` | Names the app, the cluster (`<name>-db`), the bucket (`<name>-sites`) and the key |
| `region` | `ams3` | The datacentre |
| `app_host`, `sites_domain` | (required) | The addresses |
| `site_cookie_domain` | `sites_domain` | `SITE_COOKIE_DOMAIN` |
| `dns_zone` | none | The DigitalOcean domain App Platform manages the records in |
| `image_tag` | (required) | The tag the app starts on; afterwards the workflow pins each release by digest |
| `registry_name`, `create_registry`, `registry_tier` | —, `true`, `basic` | The registry |
| `instance_size_slug`, `instance_count` | `apps-s-1vcpu-1gb`, `1` | The containers. More than one share the Table and their live rooms through Postgres, and every tick is safe to repeat |
| `database_size`, `database_node_count` | `db-s-1vcpu-1gb`, `1` | The cluster |
| `bucket_name` | `<name>-sites` | The bucket (names are unique per region) |
| `instance` | `{}` | The instance's own configuration ([below](#instance-configuration)) |
| `instance_secrets` | `{}` | Its secrets: `OIDC_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET`, `SMTP_PASSWORD`. Like `instance`, it may not set a variable the module owns, nor `SERVERS` |
| `alert_emails` | the team's | Who is told of a failed deploy or domain |

`examples/basic` is a root module to copy. Terraform owns the shape; the workflow owns the code.
The module ignores the service's image tag and digest after creation, so an apply never rolls a
deploy back.

### The Node host's environment

The module sets what the image needs (every variable is in
[platforms/node/README.md](../node/README.md)):

- `APP_ENV=production`, `APP_ORIGIN=https://$APP_HOST`, `SITES_DOMAIN`, `SITE_COOKIE_DOMAIN`,
  `LIVE_URL=wss://$APP_HOST/api/live` (App Platform carries WebSockets);
- `DATABASE_URL`, a direct connection to the cluster's primary (never a pool in transaction mode,
  which would break the migrations' lock and the live rooms' `LISTEN`), and `DATABASE_CA_CERT`,
  the cluster's CA, which the host checks the server's certificate against;
- `STORAGE_DRIVER=s3`, `SITES_BUCKET`, `S3_ENDPOINT=https://$REGION.digitaloceanspaces.com`,
  `S3_REGION`, the bucket key, and `S3_UPLOAD_DIGEST=md5`: a presigned upload binds the file's
  `Content-MD5`, which Spaces checks, and a file whose MD5 an older CLI did not send goes through
  the host's upload route. Whether Spaces rejects a body that differs from a signed
  `x-amz-checksum-sha256` is unconfirmed, so the SHA-256 binding is not used;
- the three generated secrets, `instance`, and `instance_secrets` (as encrypted variables).

## Instance configuration

Everything that makes an instance *this* instance is configuration: the module's `instance` map
(`INSTANCE_NAME`, `ALLOWED_EMAIL_DOMAINS` or `ALLOWED_EMAILS`, `ADMIN_EMAILS`, `OIDC_ISSUER`,
`OIDC_CLIENT_ID`, `BRAND_*`, `INVITES`, …) and `instance_secrets`. Every key is described in
[platforms/aws/DEPLOY.md, Instance configuration](../aws/DEPLOY.md#instance-configuration). The
module refuses keys it sets itself. Changing them is a `terraform apply`, which App Platform rolls
out as a new deployment of the same image.

**Sign-in** is OpenID Connect, as on every platform:
[platforms/aws/DEPLOY.md, Sign-in](../aws/DEPLOY.md#sign-in-openid-connect). The redirect URI is
`https://$APP_HOST/auth/callback` (`/auth/google/callback` for a Google client).

**Email** is SMTP (DigitalOcean has no mail service): any provider or relay that takes it.

```hcl
instance = {
  # …
  MAIL_DRIVER = "smtp"
  MAIL_FROM   = "fling@mail.fling.example.com" # mail.<sites domain>, or another domain
  SMTP_HOST   = "smtp.example.net"
  SMTP_PORT   = "587"
  SMTP_USER   = "fling"
}
instance_secrets = { SMTP_PASSWORD = var.smtp_password }
```

If your provider's port is refused, try its other submission port (465 or 587). With mail,
notifications and outside invitations (`INVITES=on`) work.

**Site servers are off.** `SERVERS` must stay `off` (the module refuses anything else): site
servers run untrusted code and need a sandboxed runtime, which App Platform does not offer. The
`servers` capability is then off, and clients hide the feature.

## One-time setup

1. **The domain.** Add `$ZONE` under Networking → Domains and point its nameservers at
   DigitalOcean (or leave `dns_zone` unset and add the records yourself, after step 4).
2. **The registry.** It must hold the image before the app is made, so create it first:

   ```bash
   terraform apply -target=module.fling.digitalocean_container_registry.fling
   ```

3. **The first image.** From a checkout of the release you will deploy (App Platform runs
   `linux/amd64`):

   ```bash
   doctl registry login
   docker buildx build --platform linux/amd64 -f platforms/node/Dockerfile \
     --build-arg FLING_MCPB_SERVER_URL=https://$APP_HOST \
     -t registry.digitalocean.com/$REGISTRY/fling-node:<release> --push .
   ```

4. **Everything else**, with `image_tag = "<release>"`: `terraform apply`. The app's first
   deployment migrates the empty database on start. Then:
   - `terraform output -json deploy` → the repository variable `DO_DEPLOY_CONFIG`;
   - `terraform output -raw tick_secret` → the `digitalocean` environment's secret
     `FLING_TICK_SECRET`.
5. **The workflow's environment.** Create the GitHub environment `digitalocean` (Settings →
   Environments) with required reviewers, and its secret `DIGITALOCEAN_ACCESS_TOKEN`: a token
   scoped to the app (read, update) and the registry (read, write). DigitalOcean has no OIDC
   federation for GitHub Actions, so this is a long-lived token: scope it, give it an expiry and
   rotate it.
6. **The smoke test's keys** (optional): `FLING_E2E_API_KEY` and the others, as for
   [Cloudflare's smoke test](../cloudflare/DEPLOY.md#smoke-test).

### Secrets and state

The generated secrets, the database password and the bucket key are App Platform encrypted
variables, and they are also in Terraform state: App Platform's environment has no write-only
argument (the AWS module keeps its secrets out of state that way). Keep the state in an encrypted,
private backend only the operators can read, such as a Spaces bucket of its own
(`examples/basic` shows the backend). To rotate a generated secret, taint its `random_password` and
apply (a new `SESSION_SECRET` signs everyone out).

## How a deploy ships

Run the `Deploy (DigitalOcean)` workflow (`.github/workflows/deploy-digitalocean.yml`) by hand
with a release tag as `ref`. In order:

1. builds the image from the tag, with the instance's address baked into the Claude Desktop
   extension, and pushes `<registry>/fling-node:<release>`;
2. updates the app's spec with only the service's image changed, pinned to the digest just
   pushed (never the tag, which a later push could move), and waits for the deployment. The image
   is pushed as one manifest without attestations, so that digest is the image itself.
   Deploying a release again pushes its tag again: the previous image is left untagged, and the
   registry's garbage collection may remove it, so roll back by running the workflow again
   rather than by pointing the app at an old digest. App Platform starts the new containers, waits for `/healthz`, then moves traffic.
   Each container applies the schema and data migrations on start, under a lock;
3. waits until `https://$APP_HOST/.well-known/fling` answers for this instance with this release;
4. calls `POST /ticks/migrate` with `FLING_TICK_SECRET` until it reports `done`;
5. runs the e2e smoke test.

## Ticks

Each container runs the notifications tick every minute (with mail) and maintenance every 15 minutes, in
process. Every tick is safe to repeat (its leases are conditional writes in the Table), so any
number of containers may run them. App Platform's scheduled jobs run at most every 15 minutes, too
seldom for the minute tick. `POST /ticks/notify` and `/ticks/maintain` also answer with
`TICK_SECRET`, for an outside scheduler.

## Rollback

Run the workflow with an earlier release tag. The image goes back; the database's schema and data
migrations don't (they are forward-only and written so the release before keeps working), and
neither does site content. App Platform's own rollback (the app → Activity → a deployment →
Rollback) also works.

Before rolling back to a release before 0.16.0, choose the `json` route format in Admin → Settings
and wait until its panel says the rewrite has finished: those releases read only `json` routes
([Route table size and format](../aws/DEPLOY.md#route-table-size-and-format)).

## What is not verified yet

The module plans against mocked providers in every `pnpm gate`, and the image passes the e2e
scenario under Docker Compose (Postgres and MinIO,
[platforms/node/DEPLOY.md](../node/DEPLOY.md)). Not yet run against a real DigitalOcean account:

- App Platform's wildcard certificate and records with `zone` set, and its health check of
  `/healthz`;
- the blobs conformance suite against Spaces, in MD5 mode and (to settle the question) SHA-256;
- the deploy workflow end to end, and the smoke test against the deployed instance.

## Costs

The smallest shape: one `apps-s-1vcpu-1gb` container, a one-node `db-s-1vcpu-1gb` cluster, Spaces
(one monthly price with 250 GiB of storage and 1 TiB of transfer) and a basic registry. Check
DigitalOcean's pricing pages for current figures.
