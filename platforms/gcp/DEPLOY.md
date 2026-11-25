# Deploying Fling on Google Cloud

**Ask your agent:**

```text
Clone https://github.com/nearform/fling and follow platforms/gcp/DEPLOY.md
to install Fling on my Google Cloud project at fling.yourdomain.com.
Before you create or change anything, ask me for what you need
(the project, the region, the DNS zone and the sign-in provider) and show me the plan.
When it is live, tell me the host our Claude admin must allow for Claude's code execution
(the guide's "Claude's sandbox" section).
```

Or follow the steps below yourself.

> **After it is live:** have your Claude admin add the Fling's host (for example
> `fling.yourdomain.com`) to **Additional allowed domains** for Claude's code execution, on
> claude.ai under **Organization settings → Capabilities**. Without it, Claude can't upload the
> files it makes and stops to ask for it. See [Claude's sandbox](../aws/DEPLOY.md#claudes-sandbox-allow-your-flings-host).

How Fling works on Google Cloud, element by element:
[docs/platforms/gcp.md](../../docs/platforms/gcp.md).

Fling runs on Google Cloud as **one Cloud Run service**, the Node host with the Google Cloud
adapters, behind a global external Application Load Balancer. Its data is in Firestore, its sites'
files in Cloud Storage and its secrets in Secret Manager; Cloud Scheduler calls its ticks. The
Terraform module `platforms/gcp/infra` builds all of it; the `Deploy (Google Cloud)` workflow ships
the code. One deployment is an **instance**: its own hostnames, sign-in allowlist, name and look,
all configuration, none of it in the code.

The examples use these placeholders; substitute your own:

| Placeholder | Example | What |
| --- | --- | --- |
| `$PROJECT` | `example-project` | The Google Cloud project, with billing on |
| `$REGION` | `europe-west1` | Where the service, the bucket and the schedules run |
| `$APP_HOST` | `fling.example.com` | The app (UI + API); sites are `<name>.$APP_HOST` |
| `$NAME` | `example-production-fling` | `<namespace>-<env>-<name>`, which names every resource |

```
$APP_HOST, *.$APP_HOST   global external Application Load Balancer
                         (Certificate Manager: one certificate for both, DNS authorisation)
  $APP_HOST     → backend $NAME-app   ─┐
  *.$APP_HOST   → backend $NAME-sites ─┴─ serverless NEG → Cloud Run service $NAME
                  (Cloud CDN with cdn = true)
                    the Node host: /api, /auth, /mcp, /oauth, /.well-known → the API core
                                   GET /api/live → the live rooms (WebSocket, in process)
                                   /blob-upload, /blob-download → uploads without an MD5
                                   /ticks/* → ticks and migrations (Google ID tokens only)
                                   everything else on $APP_HOST → the web UI (in the image)
                                   *.$APP_HOST → the shared site routing decision → GCS
Cloud Scheduler   maintain every 15 min, notify every minute (with mail): POST /ticks/* with OIDC
Firestore $NAME (items), bucket <prefix>$NAME-sites, Secret Manager $NAME-*, Artifact Registry $NAME
```

| Who | Owns |
| --- | --- |
| Terraform (`platforms/gcp/infra`, run by you) | The service's configuration and environment, Firestore and its indexes, the bucket, the load balancer, the certificate, DNS (with `dns_zone`), the schedules, the service accounts, Workload Identity Federation and which secrets exist |
| You, by hand | The secrets someone fills (the sign-in client's, the SMTP password), the GitHub environment and variable |
| The deploy workflow | The image (the service, the web UI and the Claude Desktop extension), each revision, the data migrations |
| The service at runtime | Firestore documents and the bucket's objects |

The service takes requests only from the load balancer (ingress `internal-and-cloud-load-balancing`
in the console, `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER` in Terraform): its `run.app` URL refuses
the internet. That ingress also admits callers inside the project's VPC networks (and a Shared VPC
it is attached to), so the ticks and migrations check their own caller rather than trust the path.

## Requirements

- **A Google Cloud project with billing**, and an account that may administer it (Owner, or the
  roles to create everything below).
- **Terraform 1.11 or later** (write-only attributes keep the generated secrets out of state) and
  the `gcloud` CLI.
- **A domain** for `$APP_HOST` and `*.$APP_HOST`, in a Cloud DNS zone of the project or anywhere you
  can add records.
- **A GitHub repository** to deploy from: this one, or your fork.

The APIs the instance uses are enabled by Terraform. Terraform itself needs two first:

```bash
gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com \
  --project "$PROJECT"
```

## Infrastructure: the Terraform module

Copy [infra/examples/basic](infra/examples/basic/main.tf) into your own Terraform repository, pin a
release of the module (`?ref=infra-gcp-v<x.y.z>`), and fill in its values:

| Input | What |
| --- | --- |
| `project_id`, `region` | Where it runs. `firestore_location` (default: the region) can be a multi-region such as `eur3`; it can't change later |
| `namespace`, `env`, `name` | The resource names, `<namespace>-<env>-<name>` |
| `bucket_prefix` | Keeps the bucket's name globally unique |
| `hostname` | `$APP_HOST` |
| `dns_zone` | A Cloud DNS managed zone in the project that holds the hostname: the module adds the records. `null`: add the `dns_records` output yourself |
| `github` | The deploying repository's owner and name with their numeric ids (`gh api repos/<owner>/<repo> --jq '.owner.id, .id'`), and the GitHub environment (default `gcp`) |
| `instance` | The instance's own values ([Instance configuration](../aws/DEPLOY.md#instance-configuration)); they become `INSTANCE` in the deploy output |
| `environment` | Extra environment variables for the service (not secret) |
| `service` | `cpu`, `memory`, `min_instances` (0 scales to zero), `max_instances` (1 by default), `concurrency`, `timeout_seconds` |
| `live` | Live rooms on review pages (default on). They need `max_instances = 1`; set `live = false` to scale out |
| `cdn` | Cloud CDN on the sites' backend (default off; see [Cloud CDN](#cloud-cdn)) |
| `mail` | Email over SMTP ([Email](#email)) |
| `manual_secrets`, `generated_secrets`, `secrets_version` | The secrets ([Secrets](#secrets)) |

Then:

```bash
gcloud auth application-default login
terraform init
terraform apply
```

The certificate is issued once the DNS authorisation's CNAME resolves, usually within an hour; until
then the load balancer answers TLS with an error. With `dns_zone` the records are made for you;
otherwise add every entry of `terraform output dns_records` (A and AAAA for `$APP_HOST` and
`*.$APP_HOST`, and the `_acme-challenge` CNAME) where your DNS is.

The first apply starts the service on a placeholder image, which answers every request until the
first deploy. A plan after a deploy reads "No changes": the image is the deploy's.

## Secrets

Each secret is a Secret Manager secret named `$NAME-<secret>`. Cloud Run puts its latest version
in the service's environment when an instance starts, as the secret's name in upper case
(`session-secret` is `SESSION_SECRET`), so the service makes no Secret Manager call of its own.

- **Generated** (`generated_secrets`: `session-secret`, `site-hmac-key`): 40 random characters,
  generated in memory and written with a write-only attribute, so never in Terraform state. Bump
  `secrets_version` to regenerate them, then deploy, which signs everyone out.
- **Filled by hand** (`manual_secrets`: `oidc-client-secret` by default; `google-client-id` and
  `google-client-secret` for a Google client; `smtp-password`, added with `mail`): created with the
  placeholder `unset`, which the service reads as not set. Add the real value as a new version:

```bash
gcloud secrets versions add "$NAME-oidc-client-secret" --project "$PROJECT" \
  --data-file=oidc-client-secret.txt
```

A new version reaches instances that start after it: deploy again (or start a new revision) to
replace the running ones. `terraform output manual_secrets` lists the secrets to fill.

## The deploy config (GCP_DEPLOY_CONFIG)

The deploy workflow takes everything from one repository variable, the module's `deploy` output as
JSON:

```bash
terraform output -json deploy | gh variable set GCP_DEPLOY_CONFIG -R <owner>/<repo>
```

| Key | What |
| --- | --- |
| `GCP_PROJECT`, `GCP_REGION` | Where the instance is |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | The provider GitHub's OIDC token is exchanged with |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | What the workflow becomes: it may push images, deploy the service and mint ID tokens for itself |
| `SERVICE`, `IMAGE_REPOSITORY` | The Cloud Run service and the Artifact Registry repository |
| `APP_ORIGIN` | `https://$APP_HOST` |
| `INSTANCE` | The instance's own values (from `instance`), built into the image as `instance.json` |

Nothing in it is secret. Then create the GitHub environment the module trusts (`gcp` unless you
named another in `github.environment`), with whatever protection rules you want on deploys:

```bash
gh api -X PUT repos/<owner>/<repo>/environments/gcp
```

Only jobs in that environment, in that repository (by id), can become the deploy service account.

## First deploy

Run the workflow with a release tag:

```bash
gh workflow run deploy-gcp.yml -R <owner>/<repo> -f ref=v<x.y.z>
```

It ships the commit only if it is on `main`. Then sign in at `https://$APP_HOST`.

## How a deploy ships

The `Deploy (Google Cloud)` workflow (`.github/workflows/deploy-gcp.yml`), by hand only:

1. builds the service (`pnpm --filter "@fling/platform-gcp..." build`, which writes
   `instance.json` from `INSTANCE`), the web UI and the Claude Desktop extension, and the image
   (`platforms/gcp/Dockerfile`), tagged with the commit, into Artifact Registry;
2. deploys a revision on that image (`gcloud run services update --image`); it takes the traffic
   once it is ready;
3. runs the data migrations ([Data migrations](#data-migrations));
4. waits until `/.well-known/fling` answers for this instance and release.

Changing `instance` takes a new `terraform output -json deploy` in `GCP_DEPLOY_CONFIG` and a
deploy; changing `environment`, `mail` or `service` takes `terraform apply`, which starts a new
revision on the same image.

## Sign-in (OpenID Connect)

Sign-in is the same on every platform: see
[Sign-in (OpenID Connect)](../aws/DEPLOY.md#sign-in-openid-connect) in the AWS guide. On Google
Cloud the client secret is the `$NAME-oidc-client-secret` secret, and a Google client's id and
secret are `$NAME-google-client-id` and `$NAME-google-client-secret` (add both to
`manual_secrets`). The redirect URIs are `https://$APP_HOST/auth/callback` and
`https://$APP_HOST/auth/google/callback`.

## Email

Google Cloud sends no email, so Fling sends through a transactional provider's SMTP server
(SendGrid, Mailgun, Postmark, Amazon SES and others). Outbound port 25 is blocked on Google Cloud;
465 and 587 are not. Set `mail` and apply:

```hcl
  mail = {
    from = "fling@mail.fling.example.com"
    smtp = { host = "smtp.example-provider.test", port = 587, user = "apikey" }
  }
```

Then fill `$NAME-smtp-password` and deploy. The service gets `MAIL_DRIVER=smtp` and the `SMTP_*`
settings, and a Cloud Scheduler job drains the notifications every minute. The sending domain's
SPF, DKIM and DMARC are the provider's to set up; `from` must not be on the sites domain itself.
[Outside invitations](../aws/DEPLOY.md#outside-invitations) need email.

## Ticks

Cloud Scheduler calls `POST https://$APP_HOST/ticks/maintain` every 15 minutes
(`maintenance_schedule`, waiting up to 300 s) and, with mail,
`/ticks/notify` every minute, through the load balancer, each with a Google-signed ID token for the
scheduler's service account whose audience is the app origin. The service checks the token's
signature, issuer, expiry, audience and service account (`platforms/gcp/src/ticks.ts`); anything
else gets a 404. Every tick is safe to repeat.

## Data migrations

The deploy calls `POST https://$APP_HOST/ticks/migrate` with an ID token of the deploy service
account until the report says `done`; each call runs for up to 50 seconds. The code it deployed
serves correctly before they run. A 404 means the token was refused: check that the service's
`TICK_SERVICE_ACCOUNTS` (set by Terraform) names the deploy service account. To run them by hand as
someone who may impersonate it:

```bash
TOKEN="$(gcloud auth print-identity-token --audiences "https://$APP_HOST" --include-email \
  --impersonate-service-account "$DEPLOY_SERVICE_ACCOUNT")"
curl -X POST -H "Authorization: Bearer $TOKEN" "https://$APP_HOST/ticks/migrate"
```

Before a migration first runs in production, rehearse it on a copy: point-in-time recovery is on
for the database, so it can be cloned as it was at a moment into a new database, which a second
instance points at with `FIRESTORE_DATABASE` (in `environment`). The rehearsal is a live action.

## Live rooms and scaling

Review pages' live rooms are WebSockets to the service, and a room's sockets must all reach one
process, so live rooms need `service.max_instances = 1` (the default). That instance serves up to
`service.concurrency` requests at once. To scale out, set `live = false` and raise `max_instances`;
review pages then poll. A WebSocket lasts at most `service.timeout_seconds` (up to an hour), after
which the page reconnects.

## Cloud CDN

Off by default: every request reaches the service, so a change of access, a rollback or a deleted
site is seen at once. With `cdn = true`, Cloud CDN caches the sites' backend, keyed by host, path
and query, under the service's own `Cache-Control`: a public site's files. It never keeps what the
service sends `private` (every file of a site that isn't public, and everything on a share link),
`no-store` (404s, sign-in hops) or with a cookie, nor anything on `$APP_HOST`. A site's URLs stay
the same across versions, so the module caps the edge's copy at a minute (`max_ttl` 60 s, cache
mode `CACHE_ALL_STATIC`): a publish, a rollback, a deletion or a site made private reaches every
viewer within that minute. Browsers keep the max-age the service sends.

## Deleted sites

With `SITE_DELETE=soft`, the default, a deleted site's files stay where they were, with a recovery
file beside them: `sites/<siteId>/`, each of its Paths' `sites/<pathId>/`, and a `deleted.json` in
each. An admin restores one, or deletes it for good, on **Admin → Deleted** in the web app, from
their own browser session. What is kept, recovering a site by hand when a restore can't, the cost
and the known risks are in [Deleted sites](../aws/DEPLOY.md#deleted-sites) in the AWS guide; it is
the same here. So is the
[archive policy](../aws/DEPLOY.md#archive-policy), which can purge them `PURGE_DELETED_DAYS` after
their delete.

The prefixes are in the sites bucket (`<prefix>$NAME-sites`; `BUCKET=$(terraform output -raw sites_bucket)`).
In the console, **Cloud Storage → Buckets →** the bucket, then `sites/<siteId>/`. From a shell:
`gcloud storage ls "gs://$BUCKET/sites/*/deleted.json"` finds every recovery file,
`gcloud storage cat gs://$BUCKET/sites/<siteId>/deleted.json` reads one, and
`gcloud storage cp -r "gs://$BUCKET/sites/<siteId>/<versionId>/*" ./recovered` downloads a version.
The bucket's lifecycle rules remove only `uploads/` leftovers and unfinished uploads.

## Claude's sandbox: allow your Fling's host

So that Claude can upload the files it makes with code execution rather than typing them out
again, your Claude admin adds your Fling's host (the host of the app's address) to **Additional
allowed domains**, on claude.ai in a web browser under **Organization settings → Capabilities →
Code execution and file creation**. Only that host is needed. See
[Claude's sandbox](../aws/DEPLOY.md#claudes-sandbox-allow-your-flings-host) in the AWS guide for
the steps and how to check them.

## Rollback

Run the workflow with an earlier release tag: it builds that release's image and deploys it. A
faster one, without a build, is a revision that already exists:

```bash
gcloud run services update-traffic "$NAME" --project "$PROJECT" --region "$REGION" \
  --to-revisions <revision>=100
```

The next deploy sends all traffic to its own revision again.

Before rolling back to a release before 0.16.0, choose the `json` route format in Admin → Routes
and wait until its panel says the rewrite has finished: those releases read only `json` routes
([Route table size and format](../aws/DEPLOY.md#route-table-size-and-format)).

## Not on Google Cloud yet

- **Site servers** (`SERVERS`): the service refuses to start with them on, and the `servers`
  capability is off.
- **Live rooms across instances**: they need one instance (above).

## Costs

At idle, roughly $20–25 a month: the load balancer's forwarding rules are about $18 whatever the
traffic. Cloud Run scales to zero (`min_instances = 0`; one warm instance is about $10–15 more), and
Firestore, Cloud Storage, Secret Manager and Cloud Scheduler sit within or near their free tiers.
