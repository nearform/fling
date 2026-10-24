# Deploying Fling

Fling runs serverless in your own AWS account (one region plus global CloudFront). The
infrastructure is Terraform you keep alongside it (until it moves into this repository as a
module); this repository ships the code. One deployment is an **instance**: its own domains,
sign-in allowlist, name and look, all configuration, none of it in the code.

The examples below use these placeholders; substitute your own:

| Placeholder | Example | What |
| --- | --- | --- |
| `$APP_DOMAIN` | `fling.example.test` | the app (UI + API) |
| `$SITES_DOMAIN` | `fling.example.test` | sites hang off it: `<name>.$SITES_DOMAIN` (may equal `$APP_DOMAIN`; must sit under the app's registrable domain) |
| `$AWS_REGION` | `eu-west-1` | |
| `$FUNCTION` | `example-fling-api` | the API's Lambda function |
| `$TABLE` | `example-fling` | its DynamoDB table |
| `$SSM_PREFIX` | `/example/fling/` | its SSM parameters |
| `$GITHUB_REPO` | `your-org/fling` | the repository that deploys (this one, or a fork) |

```
$APP_DOMAIN       CloudFront ─┬─ /api/*, /auth/*, /healthz,
                              │  /mcp, /oauth/*, /.well-known/* → Lambda $FUNCTION (function URL)
                              └─ everything else          → S3 UI bucket (SPA)
*.$SITES_DOMAIN   CloudFront ── site router (CloudFront Function + KeyValueStore)
                              └─ S3 sites bucket
DynamoDB $TABLE, SSM parameters $SSM_PREFIX*
```

| Who | Owns |
| --- | --- |
| Your Terraform | Buckets, table, distributions, DNS, certificate, roles, the function's configuration and environment, which secrets exist |
| This repo, `deploy.yml` | The Lambda code (with the instance values in `instance.json`), the UI files, `downloads/fling.mcpb` in the UI bucket, `_fling/404.html` in the sites bucket, the site router's code |
| The API at runtime | Table items, KeyValueStore keys, site files under `sites/`, chunked MCP upload staging under `uploads/` |

> **IAM for data migrations.** Deploys run data migrations by invoking the function (see
> [Data migrations](#data-migrations)). Two grants are needed in your Terraform:
>
> - the **deploy role**: `lambda:InvokeFunction` on the API function
>   (`arn:aws:lambda:$AWS_REGION:<account>:function:$FUNCTION`);
> - the **function's own role**: `dynamodb:Scan` on `$TABLE`, next to the item permissions it
>   already has. Only migrations scan.
>
> Until both exist the deploy's migrate step warns ("Data migrations NOT run") and carries on. That
> is safe: every migration is written so the code serves correctly before it has run.

The remote MCP connector (`/mcp`, OAuth under `/oauth/*` and `/.well-known/oauth-*`) needs, beyond
the routes above: DynamoDB TTL enabled on the attribute `ttl` (OAuth codes, requests, refresh
tokens, grants, DCR clients and uploads carry it), the function role allowed to `s3:PutObject`,
`s3:GetObject` and delete/list under `uploads/*` as well as `sites/*`, and ideally a lifecycle rule
expiring `uploads/` after a day. `/mcp` requests carry whole sites, so CloudFront must forward
`POST` bodies up to the Lambda limit (6 MB) and the `Authorization`, `Mcp-Protocol-Version` and
`Accept` headers. Access tokens are signed with a key derived from `SESSION_SECRET` (HKDF), so no
new secret is needed; rotating `SESSION_SECRET` invalidates live access tokens (clients just refresh;
refresh tokens are opaque and stored hashed). `OAUTH_REDIRECT_ALLOWLIST` (optional) overrides the allowed OAuth redirect URIs.

## Instance configuration

Everything that makes an instance *this* instance is configuration. The API publishes it at
`GET https://$APP_DOMAIN/.well-known/fling` (public, cached 5 minutes, CORS `*`); the CLI
(`fling login <url>`), the MCP servers and the web UI read it, so the published CLI, the Claude
plugin and the built UI work with any instance.

Values reach the function two ways, and the function's own environment wins:

1. **The function's environment**, from your Terraform (the deployment plumbing below has always
   come this way: `APP_ORIGIN`, `SITES_DOMAIN`, `SITE_COOKIE_DOMAIN`, `TABLE_NAME`, `SITES_BUCKET`,
   `KVS_ARN`, `SSM_PREFIX`, `APP_ENV=production`).
2. **`instance.json` in `lambda.zip`**, written at deploy time from the `INSTANCE` object in
   `AWS_DEPLOY_CONFIG` (below). Use it for the instance's identity, so changing it needs no
   infrastructure change.

| Key | Required | What |
| --- | --- | --- |
| `ALLOWED_EMAIL_DOMAINS` | **yes** (production refuses to start without it; the deploy checks `INSTANCE` has it) | Comma-separated email domains that may sign in, e.g. `example.test`. A verified email must match one (and Google's `hd` claim, when present, must match it). |
| `OIDC_ISSUER` | **yes**, with the next one (see [Sign-in](#sign-in-openid-connect)) | The OpenID Connect issuer, exactly as its tokens' `iss`, e.g. `https://accounts.google.com`. Must be `https`. |
| `OIDC_CLIENT_ID` | with `OIDC_ISSUER` | The client (application) id registered with the issuer. Its secret is the SSM parameter `oidc-client-secret`. |
| `OIDC_DISPLAY_NAME` | no (derived: Google, Microsoft, Okta, Auth0, else the issuer's host) | What the button says: "Sign in with …". |
| `OIDC_SCOPES` | no (`openid email profile`) | Space- or comma-separated scopes; must include `openid` and give an `email` claim. |
| `OIDC_ASSUME_EMAIL_VERIFIED` | no (`false`) | `true` treats an ID token *without* `email_verified` as verified. See [Sign-in](#sign-in-openid-connect). |
| `INSTANCE_NAME` | no (`Fling`) | The name the UI, the CLI and the MCP descriptions show. |
| `INSTALL_COMMAND` | no (`npm install -g` + the CLI package) | How the Get started page tells people to install the CLI. |
| `BRAND_PRIMARY` | no | Hex colour behind primary buttons and active states, e.g. `#4f46e5`. |
| `BRAND_PRIMARY_CONTENT` | no | Hex colour of text on `BRAND_PRIMARY`. |
| `BRAND_ACCENT` | no | Hex colour of links and focus rings. |
| `BRAND_INK` | no | Hex colour of text and the dark chrome; the UI derives its greys and dark theme from it. |
| `BRAND_HIGHLIGHT` | no | Hex colour used decoratively (the animated thread, the sign-in wash). |
| `BRAND_LOGO_URL` | no | Logo mark shown before the name: an `https:` URL or a `data:image/…` URI (an SVG data URI keeps it self-contained). |
| `BRAND_LOGO_DARK_URL` | no | The same for the dark theme (defaults to `BRAND_LOGO_URL`). |
| `BRAND_FAVICON_URL` | no | Favicon, `https:` or `data:image/…`. |

Without any `BRAND_*` value the UI uses its neutral default theme. The UI applies the brand at
runtime, so one build serves every instance; it caches the last brand in the browser so later visits
don't flash the default. Logos and fonts are never part of this repository: host the files wherever
you like (your own site or CDN), or inline small SVGs as `data:` URIs in the config.

Example `INSTANCE` object:

```json
{
  "ALLOWED_EMAIL_DOMAINS": "example.test",
  "OIDC_ISSUER": "https://accounts.google.com",
  "OIDC_CLIENT_ID": "1234-abcd.apps.googleusercontent.com",
  "INSTANCE_NAME": "Example Fling",
  "BRAND_PRIMARY": "#00e5a4",
  "BRAND_PRIMARY_CONTENT": "#000e38",
  "BRAND_ACCENT": "#166bff",
  "BRAND_INK": "#000e38",
  "BRAND_HIGHLIGHT": "#8950ff",
  "BRAND_LOGO_URL": "https://assets.example.test/fling/logo.svg"
}
```

## Sign-in (OpenID Connect)

An instance signs people in with one OpenID Connect provider: the authorization code flow with
PKCE, `state` and `nonce`, endpoints from the issuer's discovery document
(`$OIDC_ISSUER/.well-known/openid-configuration`), and an ID token whose signature (the issuer's
JWKS; rotated keys are picked up), issuer, audience, expiry and nonce are checked. Then the email
policy: the ID token's `email` must be verified (`email_verified: true`) and its domain in
`ALLOWED_EMAIL_DOMAINS`.

On the provider, register a confidential **web** client with:

- the redirect URI `https://$APP_DOMAIN/auth/callback` (a separate dev client can allow
  `http://fling.lvh.me:47100/auth/callback` to try it locally),
- the scopes `openid email profile`,
- its client secret stored as `${SSM_PREFIX}oidc-client-secret` (SecureString).

Then set `OIDC_ISSUER` and `OIDC_CLIENT_ID` in `INSTANCE`. Examples (`example.test` stands for your
domain):

| Provider | `OIDC_ISSUER` | Notes |
| --- | --- | --- |
| Google | `https://accounts.google.com` | Google Cloud console, APIs & Services, Credentials, an OAuth client of type Web application. An Internal consent screen limits it to your Workspace. With one allowed domain, sign-in hints it (`hd`). |
| Microsoft Entra ID | `https://login.microsoftonline.com/<tenant id>/v2.0` | App registrations, a Web platform with the redirect URI, a client secret, and the optional `email` claim on the ID token. Use your tenant's issuer, never `common` or `organizations`. Entra sends no `email_verified`: set `OIDC_ASSUME_EMAIL_VERIFIED=true` only if your tenant's admins control every account's email. |
| Okta | `https://example-test.okta.com` (or `…/oauth2/default` for a custom authorization server) | An OIDC Web Application with the sign-in redirect URI; assign the people who may use it. |
| Auth0 | `https://example-test.eu.auth0.com/` (with the trailing slash, as Auth0's `iss` has it) | A Regular Web Application with the callback URL. |

**Why `email_verified` is required.** Fling knows people by email, so an unverified address could
claim someone else's sites. An ID token with `email_verified: false` is always refused. One with
no `email_verified` at all is refused too, unless `OIDC_ASSUME_EMAIL_VERIFIED=true` says this
issuer only hands out addresses its admins control (a single-tenant Entra ID, for example).

**Before generic OIDC** an instance signed in with Google from the SSM parameters
`google-client-id` and `google-client-secret`, on the redirect URI
`https://$APP_DOMAIN/auth/google/callback`. That still works unchanged: with no `OIDC_ISSUER`, those
parameters are read as `OIDC_ISSUER=https://accounts.google.com` on the old callback (the function
logs a deprecation warning at cold start), and `/auth/google` and `/auth/google/callback` stay as
aliases of `/auth/login` and `/auth/callback`. To move to the new settings: add
`https://$APP_DOMAIN/auth/callback` to the Google client's redirect URIs, put the secret at
`${SSM_PREFIX}oidc-client-secret`, set `OIDC_ISSUER` and `OIDC_CLIENT_ID` in `INSTANCE`, deploy, and
then delete the two `google-client-*` parameters.

## One-time setup

1. **Infrastructure.** Apply your Terraform: buckets, table, both distributions, certificate, DNS,
   the function (with the environment above), its role, the deploy role and the secrets. The deploy
   role trusts GitHub's OIDC provider for `$GITHUB_REPO`'s `production` environment only.

2. **Sign-in client.** Register a web client with your OpenID Connect provider (see
   [Sign-in](#sign-in-openid-connect)) and store its secret as the SSM SecureString parameter
   `${SSM_PREFIX}oidc-client-secret`. The other secrets (`session-secret`, `site-hmac-key`,
   `origin-verify-secret`) are generated by Terraform.

3. **Redirect URI.** On that client, allow `https://$APP_DOMAIN/auth/callback`, and put
   `OIDC_ISSUER` and `OIDC_CLIENT_ID` in the `INSTANCE` object (next step).

4. **GitHub environment and config.** In the repository, create the environment `production`
   (Settings, Environments; deployment branches: `main` only). Then set the deploy config: the
   Terraform stack's deploy outputs plus the instance's `INSTANCE` object, for example:

   ```bash
   terraform output -json deploy \
     | jq -c --argjson instance "$(cat instance.json)" '. + {INSTANCE: $instance}' \
     | gh variable set AWS_DEPLOY_CONFIG -R "$GITHUB_REPO"
   ```

   It holds `AWS_REGION`, `AWS_DEPLOY_ROLE_ARN`, `LAMBDA_FUNCTION`, `UI_BUCKET`, `SITES_BUCKET`,
   `SITE_ROUTER_FUNCTION`, `APP_DISTRIBUTION_ID`, `SITES_DISTRIBUTION_ID`, `APP_ORIGIN` and
   `INSTANCE` (see [Instance configuration](#instance-configuration)). Nothing in it is secret.

5. **npm trusted publishing (no token)**, only for the repository that publishes the CLI. Publish
   the very first version by hand (`npm login`, then `npm publish <tarball> --access public` from a
   `pnpm pack` of `apps/cli`). Then on npmjs.com open the package, go to **Settings → Trusted
   publishing**, add GitHub Actions with the repository's organization and name and the workflow
   `release-cli.yml`, and finally set **Publishing access → Require two-factor authentication and
   disallow tokens**. Every dependency is public, so installs need no token either.

6. **First deploy.** Push to `main`, or run the Deploy workflow by hand. Until then the API answers
   503, the UI bucket is empty and the site router passes requests straight through.

## How a deploy ships

Every push to `main` runs `ci.yml` (`pnpm gate`). When it passes, `deploy.yml` builds the same commit
and, with the deploy role over OIDC:

1. Uploads `platforms/aws/dist/lambda.zip` (the `apps/api` core bundled with the AWS adapters by
   `pnpm --filter @fling/platform-aws build`, with `INSTANCE` written into it as `instance.json`) to
   the function and waits until it is live.
   Then runs the pending [data migrations](#data-migrations): it invokes the function with
   `{"fling":"migrate"}` until the report says `done`. A failing migration stops the deploy here
   (the API keeps working); missing permissions only warn. Then a smoke test: `/.well-known/fling`
   on `APP_ORIGIN` must answer from the new code for this instance before the UI is touched.
2. Syncs `apps/web/dist` to the UI bucket: `assets/` first (hashed, cached for a year, never deleted,
   so open tabs keep working), then the other files, then `index.html` (`no-cache`) last.
   It also uploads the Claude Desktop extension, built by `pnpm --filter ./apps/cli build:mcpb`
   with `APP_ORIGIN` as its **Fling server** default, to `downloads/fling.mcpb`:
   `application/octet-stream`, served as an attachment, 5-minute cache. The UI sync excludes
   `downloads/*` so it doesn't delete the extension. The file has an extension, so the SPA function
   leaves it alone and it is served at `https://$APP_DOMAIN/downloads/fling.mcpb`.
3. Fills `__APP_ORIGIN__` in `apps/web/dist-404/404.html` and uploads it to
   `s3://<sites bucket>/_fling/404.html`. The sites distribution answers every S3 403 or 404 with it,
   as a 404; the page links home and brands itself from the app's `/.well-known/fling`.
4. Fills `__APP_ORIGIN__` and `__SITE_SCHEME__` in `edge/src/site-router.js`, updates the CloudFront
   Function (keeping its KeyValueStore association) and publishes it to LIVE.
5. Invalidates `/index.html` on the app distribution and `/_fling/*` on the sites distribution.

Site content is never touched by a deploy. Terraform ignores the code, so a plan after a deploy
reads "No changes".

## Rollback

Run the **Deploy** workflow by hand (Actions, Deploy, Run workflow) with `ref` set to an older commit
SHA of `main`. It rebuilds and redeploys that commit: API, UI, error page and site router together.
Old UI assets are still in the bucket, so nothing breaks while it runs.

Table items and KeyValueStore keys are not rolled back. Keep the data model backwards compatible, or
roll forward. Data migrations are written expand/contract so a rollback across one is survivable
(see [Data migrations](#data-migrations)); the one exception is a contract step, which is run by
hand and says so. A single site rolls back with `fling rollback <name> <versionId>`.

## Data migrations

Stored data is changed by migrations in `apps/api/src/migrations/NNNN-*.ts`, written once against
the Table port, idempotent and resumable (the runner keeps a checkpoint and a lock with a lease in
`MIGRATION#NNNN` items). The deploy runs the pending ones right after the new code is live, by
invoking the function with a non-HTTP event that only IAM principals with `lambda:InvokeFunction`
can send (a function URL request is always an HTTP event):

| Payload | Does |
| --- | --- |
| `{"fling":"migrate"}` | Runs pending migrations until shortly before the invocation times out; returns the report. Call again until `"done": true`. |
| `{"fling":"migrate","dryRun":true}` | The same, reading only: reports what it would write. |
| `{"fling":"migrate","only":["0002"]}` | Runs just those, including opt-in ones. |

By hand, with your own SSO credentials:

```bash
aws lambda invoke --region "$AWS_REGION" --function-name "$FUNCTION" \
  --cli-binary-format raw-in-base64-out --cli-read-timeout 0 \
  --payload '{"fling":"migrate","dryRun":true}' /dev/stdout
```

A report lists each migration with `status`: `up-to-date`, `completed`, `partial` (out of time,
call again), `busy` (another run holds its lock; a crashed run's lease runs out within 2 minutes),
`skipped` (opt-in) or `pending` (an earlier one didn't finish). Progress is also logged.

**Required permissions** (your Terraform): `lambda:InvokeFunction` on the function for the deploy role,
and `dynamodb:Scan` on the table for the function role. Without them the deploy warns and skips
the step.

### 0001: site-centric keys, and its rollback story

0001 copies every site to `SITE#<id>/SITE` and every version to `SITE#<id>/VERSION#<versionId>`,
deleting nothing; `USER#<email>/SITE#<name>` stays as the user's index item. The release that
ships it writes both layouts and reads both, so:

- **Before and during the migration** (the minutes between the code going live and the migrate step
  finishing) everything is visible: reads fall back on the old keys.
- **Rolling back** (Deploy with an older `ref`) is survivable: the old code reads only the old keys,
  and they stay complete. It ignores the new items.
- **Rolling forward** again needs nothing: reads take the newer copy of a site and the union of
  both places' versions, so whatever the old code did while rolled back shows.

**Contract (0002, opt-in, run by hand).** Once nobody will redeploy code from before 0001, run
`{"fling":"migrate","only":["0002"]}`: it brings site records up to date and deletes the old
version keys. After it, rolling back to pre-0001 code would show sites without versions. The
header of `apps/api/src/migrations/0002-*.ts` has the full order.

## Rehearsing a data migration (point-in-time copy)

Before a migration first runs in production, rehearse it on a copy of the production table restored
to a point in time. Production is never touched: the copy is a separate table and nothing points at
it. Use your own SSO credentials (the deploy role can't do this), from a checkout of the commit that
will be deployed, after `pnpm install`.

1. **Check point-in-time recovery is on** (`ENABLED`):

   ```bash
   aws dynamodb describe-continuous-backups --region "$AWS_REGION" --table-name "$TABLE" \
     --query ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus
   ```

   If it is off, take an on-demand backup instead (`aws dynamodb create-backup --table-name
   "$TABLE" --backup-name fling-rehearsal`) and restore it with
   `aws dynamodb restore-table-from-backup --target-table-name "$COPY" --backup-arn <arn>`.

2. **Restore a copy** (minutes to tens of minutes; it starts empty of TTL settings, which doesn't
   matter here):

   ```bash
   COPY="$TABLE-rehearsal-$(date -u +%Y%m%d%H%M)"
   aws dynamodb restore-table-to-point-in-time --region "$AWS_REGION" \
     --source-table-name "$TABLE" --target-table-name "$COPY" \
     --use-latest-restorable-time --billing-mode-override PAY_PER_REQUEST
   until [ "$(aws dynamodb describe-table --region "$AWS_REGION" --table-name "$COPY" \
     --query Table.TableStatus --output text)" = ACTIVE ]; do sleep 30; done
   ```

3. **Dry run** (reads only: counts per kind, anomalies already in the data, what would be written):

   ```bash
   pnpm --filter @fling/platform-aws migrate:rehearse --table "$COPY" --region "$AWS_REGION" --dry-run
   ```

4. **Rehearse** (runs the migrations on the copy, then verifies):

   ```bash
   pnpm --filter @fling/platform-aws migrate:rehearse --table "$COPY" --region "$AWS_REGION"
   ```

   It refuses a table that isn't a restored copy. It must end `Verification: PASSED`, after
   checking:
   - counts per kind before and after: nothing of the old layout lost or changed, one site record
     per old site and one copy per old version;
   - every user's sites resolve through the new layout (claim → `SITE#<id>`), every site's versions
     and current version are in its partition, and every name claim points at a matching site
     record;
   - the API (Records) serves every user's site list and every claimed site exactly as before.

   Warnings list anomalies already in the data (copied as they are), such as a site record no
   claim points at. Read them: such a site is not reachable by name after 0001.

5. **Check idempotence and resuming**: run step 4 again (`up-to-date`, `PASSED`); optionally
   restore a second copy, interrupt step 4 with Ctrl-C mid-way, and run it again: it waits out the
   lease (`--lease-seconds`, default 120) and resumes from the last checkpoint.

6. **Delete the copy**:

   ```bash
   aws dynamodb delete-table --region "$AWS_REGION" --table-name "$COPY"
   aws dynamodb wait table-not-exists --region "$AWS_REGION" --table-name "$COPY"
   ```

7. **Run it for real**: merge and let the deploy run it, then confirm with a dry run (see Data
   migrations above), which should report `up-to-date`.

## Releasing the CLI

Bump `apps/cli/package.json`, merge, then tag that commit:

```bash
git tag cli-v0.3.0 && git push origin cli-v0.3.0
```

`release-cli.yml` checks the tag matches the version, runs the gate and publishes the CLI package
(`apps/cli/package.json` `name`) to npm through trusted publishing (OIDC, no stored token), with provenance added automatically.

## Secrets

SSM SecureString parameters under `$SSM_PREFIX`, read by the function at cold start:

| Parameter | Source |
| --- | --- |
| `oidc-client-secret` | Your OpenID Connect client's secret, put there by hand (One-time setup, step 2) |
| `google-client-id`, `google-client-secret` | Deprecated: read only when `OIDC_ISSUER` is unset, as the Google issuer (see [Sign-in](#sign-in-openid-connect)) |
| `session-secret`, `site-hmac-key` | Generated by Terraform, never in its state |
| `origin-verify-secret` | Generated by Terraform. CloudFront also sends it to the function URL as `X-Origin-Verify` |

To rotate the generated ones, have Terraform regenerate them (e.g. bump a `secrets_version`), then redeploy so
warm functions pick them up. Rotating `session-secret` signs everyone out. Rotating `site-hmac-key`
also needs the copy the site router reads from the KeyValueStore updated by the API.

## Deploy security (public repository)

- **No AWS keys in GitHub.** The deploy job assumes the app's deploy role over OIDC. The role trusts
  only this repository's `production` environment, and that environment only accepts deployments from
  `main` (a deployment branch policy).
- **Deploys only run code from `main`.** They run after CI passes on a push to `main`, or by hand with
  a `ref` that must be on `main` (checked with `git merge-base --is-ancestor`). Pull request runs,
  including forks', never get the role or any secret.
- **The deploy role can't read app secrets.** It can update the Lambda code, the UI bucket,
  `_fling/*` in the sites bucket and the CloudFront functions, invalidate caches, and invoke the
  function (to run data migrations; the function does nothing else for a non-HTTP event). The
  sign-in client secret and the signing keys live in SSM, readable only by the Lambda's own role.
- **Logs are public.** They show resource names and the role ARN, which are identifiers, not
  credentials. Never `echo` anything secret in a workflow.
- Anyone who can push to `main` can deploy. Protect `main` (require pull requests) to tighten
  this.

## Costs

About $0 when idle. Lambda, CloudFront (PriceClass_100), DynamoDB on demand, the KeyValueStore,
CloudFront Functions and standard SSM parameters cost nothing or pennies at internal scale. The ACM
certificate is free. The only steady cost is S3 storage of site versions, about $0.023 per GB-month.
Logs are kept for 30 days.
