# Deploying Fling on Azure

**Ask your agent:**

```text
Clone https://github.com/nearform/fling and follow platforms/azure/DEPLOY.md
to install Fling on my Azure subscription at fling.yourdomain.com.
Before you create or change anything, ask me for what you need
(the subscription and region, the domain and its DNS zone, and the sign-in provider)
and show me the plan.
When it is live, tell me the host our Claude admin must allow for Claude's code execution
(the guide's "Claude's sandbox" section).
```

Or follow the steps below yourself.

> **After it is live:** have your Claude admin add the Fling's host (for example
> `fling.yourdomain.com`) to **Additional allowed domains** for Claude's code execution, on
> claude.ai under **Organization settings → Capabilities**. Without it, Claude can't upload the
> files it makes and stops to ask for it. See [Claude's sandbox](../aws/DEPLOY.md#claudes-sandbox-allow-your-flings-host).

How Fling works on Azure, element by element: [docs/platforms/azure.md](../../docs/platforms/azure.md).

Fling runs on Azure as **one Container App**, the Node host with the Azure adapters, behind Front
Door Standard, with Cosmos DB, Blob Storage, Web PubSub and Key Vault beside it. The
infrastructure is a Terraform module in this repository, [`platforms/azure/infra`](infra), that
you call from your own Terraform; this repository's `deploy-azure.yml` ships the code. One
deployment is an **instance**: its own domains, sign-in allowlist, name and look, all
configuration, none of it in the code.

The examples below use these placeholders; substitute your own:

| Placeholder | Example | What |
| --- | --- | --- |
| `$APP_DOMAIN` | `fling.example.test` | the app (UI + API) |
| `$SITES_DOMAIN` | `fling.example.test` | sites hang off it: `<name>.$SITES_DOMAIN` (may equal `$APP_DOMAIN`; must sit under the app's registrable domain) |
| `$LOCATION` | `westeurope` | the Azure region everything is in |
| `$GROUP` | `example-production-fling` | the resource group (`<namespace>-<env>-<name>`) |
| `$VAULT` | `example-production-abc123` | its Key Vault (the `key_vault` output) |
| `$GITHUB_REPO` | `your-org/fling` | the repository that deploys (this one, or a fork) |

```
$APP_DOMAIN, *.$SITES_DOMAIN  Front Door Standard (managed certificates; adds X-Origin-Verify)
                              └─ Container App (the Node host)
                                 ├─ app host: the API core, the web UI, the upload routes,
                                 │  /webpubsub/events (the live rooms' upstream events)
                                 └─ sites host: the shared site routing decision
                                    (route table in Cosmos DB, cached) → Blob Storage `sites`
wss://…webpubsub.azure.com/client/hubs/fling  Web PubSub (live rooms) ── events → the app
Container Apps jobs: migrate (by the deploy), maintain (every 15 min), notify (every minute, with mail)
Cosmos DB (serverless, one container), Key Vault (secrets), Log Analytics, a container registry
```

| Who | Owns |
| --- | --- |
| Terraform ([`infra`](infra), from your root module) | Every resource, the app's and the jobs' configuration and environment, Front Door and its domains, DNS (with a zone), roles, the deploy identity, which secrets exist |
| This repo, `deploy-azure.yml` (by hand, per release) | The image (the API with the instance values in `instance.json`, the web UI, the sites' pages, `downloads/fling.mcpb`), which image the app and the jobs run, data migrations |
| The app at runtime | Cosmos DB items, site files under `sites/`, chunked MCP upload staging under `uploads/` |

## Requirements

- **An Azure subscription** where you may create resource groups and role assignments (Owner, or
  Contributor with User Access Administrator), and the Azure CLI (`az`) signed in to it.
- **Terraform 1.11 or later.**
- **A DNS zone** for `$APP_DOMAIN` and `$SITES_DOMAIN`. With an Azure DNS zone the module adds
  every record itself; elsewhere you add the records from the `dns_records` output.
- **The sites domain must be under the app's registrable domain** (`fling.example.test` and
  `*.fling.example.test`, or `fling.example.test` and `*.sites.example.test`): the app sets the
  `fling_site` cookie, which lets members open private sites, on the sites domain.

## Infrastructure: the Terraform module

[`platforms/azure/infra`](infra) creates everything above in one module call. A minimal root
module is [`infra/examples/basic`](infra/examples/basic/main.tf); copy it into your own Terraform
repository and pin a release of the module (tags `infra-azure-v<x.y.z>`) from this repository or
your fork:

```hcl
provider "azurerm" {
  features {}
  subscription_id     = "<subscription id>"
  storage_use_azuread = true # the storage account has no account keys
}

module "fling" {
  source = "git::https://github.com/<owner>/fling.git//platforms/azure/infra?ref=infra-azure-v<x.y.z>"

  namespace = "example"
  env       = "production"
  location  = "westeurope"
  hostname  = "fling.example.test"
  # sites_domain = "sites.example.test" # default: the hostname

  dns_zone = { name = "example.test", resource_group_name = "example-dns" }

  github = { repository = "your-org/fling", environment = "azure" }

  instance = {
    ALLOWED_EMAIL_DOMAINS = "example.test"
    OIDC_ISSUER           = "https://login.microsoftonline.com/<tenant id>/v2.0"
    OIDC_CLIENT_ID        = "<client id>"
    INSTANCE_NAME         = "Example Fling"
  }
}
```

Then `terraform init && terraform apply`. The first apply takes a while: Front Door issues its
managed certificates (the wildcard one included) once the `_dnsauth` TXT records resolve, which
can take up to an hour. Until the first deploy the app runs a placeholder image.

What the module makes, file by file:

| File | What |
| --- | --- |
| `main.tf` | The resource group (unless `resource_group_name` names one), Log Analytics, the container registry |
| `api.tf` | The Container Apps environment, the app (ingress on 8080, scale to zero by default) and the jobs |
| `edge.tf` | Front Door Standard: the endpoint, the origin, the route, the two custom domains with managed certificates, the X-Origin-Verify rule |
| `dns.tf` | With `dns_zone`: the validation TXT records, and CNAMEs (an alias A record at the apex) to Front Door |
| `data.tf` | Cosmos DB: a serverless account (Strong consistency, one region, keys off), the database and the `items` container |
| `storage.tf` | The storage account (no account keys, no public access), the `sites` container and its lifecycle rule |
| `secrets.tf` | Key Vault (RBAC) and its secrets |
| `live.tf` | Web PubSub and its `fling` hub, with the event handler to the app |
| `mail.tf` | With `mail`: Communication Services Email, its domain and sender, their DNS records |
| `iam.tf` | The app's managed identity and its roles; the deploy identity and its federated credential |

Variables worth knowing: `container` (`cpu`, `memory`, `min_replicas`, `max_replicas`; a
`min_replicas` of 1 keeps one replica warm, so no request waits for a cold start),
`web_pubsub_sku` (`Free_F1` by default: 20 concurrent connections), `manual_secrets`,
`secrets_version`, `environment` (extra environment variables) and `mail`.

The app refuses any request without the `X-Origin-Verify` header Front Door adds, so its own
Container Apps hostname answers nothing useful. Front Door sends the app's hostname as `Host`, and
its rule set writes the visitor's as `X-Fling-Host`, overwriting any the visitor sent, which the
app routes by. The app never reads `X-Forwarded-Host`, since Front Door appends to a visitor's. The
deploy checks this (Check spoofed host headers); by hand, the app's own origin must still come
back:

```bash
curl -s -H "X-Forwarded-Host: x.$SITES_DOMAIN" -H "X-Fling-Host: x.$SITES_DOMAIN" \
  https://$APP_DOMAIN/.well-known/fling | jq .appOrigin
```

## The deploy config (AZURE_DEPLOY_CONFIG)

`deploy-azure.yml` needs one repository variable, `AZURE_DEPLOY_CONFIG`: a JSON object, the
module's `deploy` output. Nothing in it is secret.

| Key | What |
| --- | --- |
| `clientId`, `tenantId`, `subscriptionId` | The deploy identity, signed in to over GitHub OIDC (`azure/login`) |
| `resourceGroup` | Where the app and its jobs are |
| `registry`, `repository` | Where the image is pushed (`<registry>/<repository>:<commit>`) |
| `containerApp`, `jobs` | The app and the jobs updated to the new image; `jobs.migrate` is started for the data migrations |
| `frontDoor` | The profile, endpoint and app domain whose cache is purged after a deploy |
| `appOrigin`, `sitesDomain` | What `/.well-known/fling` must answer with after a deploy, and the Claude Desktop extension's default server |
| `INSTANCE` | The [instance configuration](../aws/DEPLOY.md#instance-configuration), built into the image as `instance.json`. Must have `ALLOWED_EMAIL_DOMAINS` or `ALLOWED_EMAILS` |

Instance values (`INSTANCE`) are the same on every platform: see the
[Instance configuration](../aws/DEPLOY.md#instance-configuration) table in the AWS guide. Changing
one needs a redeploy, not an apply. `MAIL_*` and `ACS_*` are refused there: email is set by the
module's `mail` variable.

## Sign-in

Sign-in is the core's OpenID Connect, as on AWS: see
[Sign-in (OpenID Connect)](../aws/DEPLOY.md#sign-in-openid-connect). Microsoft Entra ID is one
issuer (`https://login.microsoftonline.com/<tenant id>/v2.0`). The client secrets live in Key
Vault, not SSM:

- `oidc-client-secret`: the `OIDC_ISSUER` client's secret;
- `google-client-id` and `google-client-secret`: a Google client's, listed in `manual_secrets`.

Terraform creates each with the value `unset`; write the real one from a file, never inline:

```bash
az keyvault secret set --vault-name "$VAULT" --name oidc-client-secret --file oidc-client-secret.txt
```

Whoever writes it needs **Key Vault Secrets Officer** on the vault (the Terraform runner has it).
The app reads its secrets through Container Apps' Key Vault references when a replica starts, so
restart the app after changing one (`az containerapp revision restart`, or redeploy).

## One-time setup

1. **Apply the module** (above). Note the `deploy`, `key_vault` and `manual_secrets` outputs.
2. **Fill the manual secrets** in Key Vault (Sign-in, above).
3. **Without an Azure DNS zone**, add the `dns_records` output's records where your domain's DNS
   is: the `_dnsauth` TXT records, the hostname and the wildcard as CNAMEs to the Front Door
   endpoint (an apex needs your DNS host's ALIAS or ANAME record) and, with mail, the sending
   domain's.
4. **The GitHub environment**: in `$GITHUB_REPO`, create the environment `azure` (or the one in
   `github.environment`); the deploy identity trusts only that environment's jobs. Add
   reviewers or a branch rule if you want a deploy to need approval.
5. **The deploy config**:

   ```bash
   terraform output -json deploy | gh variable set AZURE_DEPLOY_CONFIG -R "$GITHUB_REPO"
   ```

6. **Deploy**: run the **Deploy (Azure)** workflow (Actions → Deploy (Azure) → Run workflow) with
   the latest release tag as `ref` (e.g. `v0.7.0`).
7. **Link previews in Slack (optional).** To give a site's link a rich preview in your Slack
   workspace, set up a Slack app: see [Link previews in Slack](#link-previews-in-slack).

Then open `https://$APP_DOMAIN`, sign in, and `fling login https://$APP_DOMAIN`.

## How a deploy ships

`deploy-azure.yml`, by hand with a release tag:

1. builds the API with the Azure adapters (`platforms/azure`, with `INSTANCE` as `instance.json`),
   the web UI and the Claude Desktop extension, and the image around them
   (`platforms/azure/Dockerfile`), and pushes it to the registry;
2. points the app (a new revision) and every job at the image;
3. starts the migrate job, which runs the pending data migrations until they report done, and
   waits for it to succeed. The code just deployed serves correctly before they run;
4. waits for `https://$APP_DOMAIN/.well-known/fling` to answer for this instance and release;
5. purges Front Door's cache of the app's domain. The sites hosts need no purge: the app gives
   their responses at most a minute in Front Door (`s-maxage=60`) and makes a response to a site
   cookie `private`, which Front Door never stores, so a publish, a rollback or an access change
   reaches every visitor within a minute (docs/platforms/azure.md, Edge and sites host).

To roll back, run it with an earlier release tag. Data migrations are written to survive a rollback
by one release ([Data migrations](../aws/DEPLOY.md#data-migrations)).

Before rolling back to a release before 0.16.0, choose the `json` route format in Admin → Routes
and wait until its panel says the rewrite has finished: those releases read only `json` routes
([Route table size and format](../aws/DEPLOY.md#route-table-size-and-format)).

## Email

Set the module's `mail` variable to send notifications (and to allow outside invitations,
`INVITES=on`):

```hcl
  mail = {
    from_name = "Example Fling" # the sender's display name
    # domain  = "mail.fling.example.test" # default mail.<sites domain>
    # username = "fling"                  # MAIL_FROM = <username>@<domain>
  }
```

The module creates Communication Services Email with that domain (customer-managed), the sender
username and a Communication Service linked to it, which the app sends through with its managed
identity (`MAIL_DRIVER=acs`). With `dns_zone` it adds the domain's TXT (ownership and SPF) and its
two DKIM CNAMEs; otherwise they are in the `dns_records` output. Once they resolve, **verify the
domain** in the portal (Email Communication Service → Provision domains → Verify), or with
`az communication email domain initiate-verification` for each of `Domain`, `SPF`, `DKIM` and
`DKIM2`. Until it is verified, sends are refused and the outbox keeps them for later.

Communication Services takes the sender's display name from the sender username, not from the
message, so `MAIL_FROM_NAME` has no effect on Azure: set `mail.from_name`. A new Communication
Services resource sends a limited number of emails an hour; ask Azure support to raise the limit
before an instance with many people relies on it.

## Live rooms

Review mode's live rooms run on Web PubSub. Pages connect to `LIVE_URL`, the hub's client
endpoint, with the core's short-lived ticket; Web PubSub sends the connect event to the app, which
admits the ticket or refuses the connection, and sends messages and disconnects there too. The
`Free_F1` tier takes 20 concurrent connections and 20,000 messages a day; `Standard_S1` is about
$49 a month. Turn live rooms off with `LIVE=false` in `INSTANCE`.

## What is off

**Site servers** (`_fling/server.mjs`) are not built on Azure yet, so the `servers` capability is
off and a publish with a server is refused. The design (Container Apps dynamic sessions) is in
[docs/platforms/azure.md](../../docs/platforms/azure.md).

## Limits

- **Cosmos DB, one partition.** Every item is in one logical partition, so every transaction is one
  batch. One logical partition holds at most 20 GB and serves at most 10,000 RU/s: the ceiling of
  an instance on Azure.
  The route table lives in it too, so the number of sites is bounded by it, not by a store of its
  own. A site takes about 5 KB plus 1.4 KB a version kept, and the throughput binds before the
  storage: an instance expecting tens of thousands of sites should choose another platform
  ([known limits](../../docs/platforms/azure.md#known-limits-one-logical-partition)).
- **Uploads pass through the app.** A SAS can't bind an upload to its bytes, so the CLI uploads
  each file to the app's upload route, which checks its SHA-256 and writes it to Blob Storage.
  The app takes request bodies up to 32 MiB (a file's limit is 25 MiB).
- **Scale to zero.** With `min_replicas = 0`, the first request after an idle spell waits for a
  replica to start (a few seconds).

## Costs

At idle, roughly $40–45 a month: Front Door Standard's base fee (about $35) and small amounts for
Key Vault, Log Analytics, the registry (Basic, about $5) and storage. The app scales to zero;
Cosmos DB serverless, Blob Storage and Web PubSub's free tier are paid per use. The jobs run a few
seconds each (maintain every 15 minutes, and the minute's notify with mail).

## Checking the edge cache

Front Door holds a sites-host response for at most a minute (`s-maxage=60`, set by the app) and
never stores a response to a signed-in viewer. To see it on a public site, fetch one of its files
twice, a few seconds apart, without cookies:

```bash
curl -sI https://$SITE.$SITES_DOMAIN/index.html | grep -iE '^(cache-control|x-cache|age):'
curl -sI https://$SITE.$SITES_DOMAIN/index.html | grep -iE '^(cache-control|x-cache|age):'
```

The first is usually `x-cache: TCP_MISS`, the second `TCP_HIT` with an `Age` under 60, and the
Cache-Control ends in `s-maxage=60`. Once the `Age` would pass 60, the next request is a miss (or a
`REVALIDATED_HIT`) and the `Age` starts again. With a `fling_site` cookie the Cache-Control is
`private` and `x-cache` says `PRIVATE_NOSTORE`.

## Deleted sites

With `SITE_DELETE=soft`, the default, a deleted site's files stay where they were, with a recovery
file beside them: `sites/<siteId>/`, each of its Paths' `sites/<pathId>/`, and a `deleted.json` in
each. An admin restores one, or deletes it for good, on **Admin → Deleted** in the web app, from
their own browser session. What is kept, recovering a site by hand when a restore can't, the cost
and the known risks are in [Deleted sites](../aws/DEPLOY.md#deleted-sites) in the AWS guide; it is
the same here, but for the late upload: on Azure every upload goes through the app's own route. So is the
[archive policy](../aws/DEPLOY.md#archive-policy), which can purge them `PURGE_DELETED_DAYS` after
their delete.

The prefixes are in the `sites` container of the module's storage account (the one in the
resource group: `az storage account list -g <resource group> --query "[].name" -o tsv`). Account
keys are off, so sign in with a role that reads blobs (Storage Blob Data Reader) and pass
`--auth-mode login`. In the portal, **Storage account → Containers → sites**, then
`sites/<siteId>/`. From a shell:
`az storage blob list --account-name <account> -c sites --prefix sites/<siteId>/ --auth-mode login -o table`
lists one, `az storage blob download --account-name <account> -c sites -n sites/<siteId>/deleted.json --file deleted.json --auth-mode login`
reads its recovery file, and
`az storage blob download-batch --account-name <account> -s sites -d ./recovered --pattern "sites/<siteId>/<versionId>/*" --auth-mode login`
downloads a version. The container's lifecycle rule touches only `uploads/`.

## Link previews in Slack

**Optional.** With a Slack app, a site's link posted in your workspace gets a rich preview when the
person who posted it can open the site. Create the app from
[docs/slack/manifest.yml](../../docs/slack/manifest.yml) and give the instance its two secrets,
`SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`, by adding `slack-signing-secret` and
`slack-bot-token` to `manual_secrets` and filling them with `az keyvault secret set`. See [Link
previews in Slack](../aws/DEPLOY.md#link-previews-in-slack) in the AWS guide for the steps.

## Claude's sandbox: allow your Fling's host

So that Claude can upload the files it makes with code execution rather than typing them out
again, your Claude admin adds your Fling's host (the host of the app's address) to **Additional
allowed domains**, on claude.ai in a web browser under **Organization settings → Capabilities →
Code execution and file creation**. Only that host is needed. See
[Claude's sandbox](../aws/DEPLOY.md#claudes-sandbox-allow-your-flings-host) in the AWS guide for
the steps and how to check them.

## Secrets

| Key Vault secret | App env | Made by |
| --- | --- | --- |
| `session-secret`, `site-hmac-key` | `SESSION_SECRET`, `SITE_HMAC_KEY` | Terraform, generated and written write-only: never in state. Bump `secrets_version` to regenerate |
| `origin-verify-secret` | `ORIGIN_VERIFY_SECRET` | Terraform; in state, since Front Door's rule sends it |
| `live-events-secret` | `LIVE_EVENTS_SECRET` | Terraform; in state, since Web PubSub's event handler URL carries it |
| `oidc-client-secret`, `google-client-id`, `google-client-secret` | `OIDC_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | You (`az keyvault secret set`); Terraform writes `unset` once |

The app never calls Key Vault: each secret is a Container Apps secret referencing it, read with the
app's identity. No Azure key is kept anywhere: Cosmos DB and Web PubSub have local keys off, the
storage account has account keys off, and the deploy signs in over OIDC.

Two of these are also readable outside Key Vault, by anyone who can read the resource that sends
them: the origin-verify secret is in the Front Door profile's rule set (Reader or CDN Profile
Contributor on the profile or its resource group shows it), and the live-events secret is the
`code` in the Web PubSub hub's event handler URL (Reader on the Web PubSub resource shows it). The
first lets a request reach the app without Front Door, past its cache; the second lets one post
events to the live rooms' handler, which still admits a connection only with a valid ticket. Keep
read access to the resource group to the people who run the instance, and bump `secrets_version`
after removing someone. The deploy identity has neither: its Front Door role only purges.
