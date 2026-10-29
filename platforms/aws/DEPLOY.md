# Deploying Fling on AWS

Fling runs serverless in your own AWS account (one region plus global CloudFront). The
infrastructure is a Terraform module in this repository, [`platforms/aws/infra`](infra), that you
call from your own Terraform; this repository's `deploy.yml` ships the code. One deployment is an
**instance**: its own domains, sign-in allowlist, name and look, all configuration, none of it in
the code.

The examples below use these placeholders; substitute your own:

| Placeholder | Example | What |
| --- | --- | --- |
| `$APP_DOMAIN` | `fling.example.test` | the app (UI + API) |
| `$SITES_DOMAIN` | `fling.example.test` | sites hang off it: `<name>.$SITES_DOMAIN` (may equal `$APP_DOMAIN`; must sit under the app's registrable domain) |
| `$AWS_REGION` | `eu-west-1` | |
| `$FUNCTION` | `example-production-fling-api` | the API's Lambda function (`<namespace>-<env>-<name>-api`) |
| `$TABLE` | `example-production-fling` | its DynamoDB table |
| `$SSM_PREFIX` | `/example/production/fling/` | its SSM parameters |
| `$GITHUB_REPO` | `your-org/fling` | the repository that deploys (this one, or a fork) |

```
$APP_DOMAIN       CloudFront ─┬─ /api/*, /auth/*, /healthz,
                              │  /mcp, /oauth/*, /.well-known/*,
                              │  /notifications/* (with mail)  → Lambda $FUNCTION (function URL)
                              └─ everything else          → S3 UI bucket (SPA)
*.$SITES_DOMAIN   CloudFront ── site router (CloudFront Function + KeyValueStore)
                              └─ S3 sites bucket
wss://…execute-api…/live  API Gateway WebSocket API ── Lambda $FUNCTION (live rooms)
DynamoDB $TABLE, SSM parameters $SSM_PREFIX*
```

| Who | Owns |
| --- | --- |
| Terraform ([`infra`](infra), from your root module) | Buckets, table, distributions, DNS, certificate, roles, the function's configuration and environment, which secrets exist |
| This repo, `deploy.yml` | The Lambda code (with the instance values in `instance.json`), the UI files, `downloads/fling.mcpb` in the UI bucket, `_fling/404.html` and `_fling/review.html` in the sites bucket, the site router's code |
| The API at runtime | Table items, KeyValueStore keys, site files under `sites/`, chunked MCP upload staging under `uploads/` |

## Infrastructure: the Terraform module

[`platforms/aws/infra`](infra) creates everything above in one module call. A minimal root module
is [`infra/examples/basic`](infra/examples/basic/main.tf); copy it into your own Terraform
repository and pin a release of this repository (or your fork):

```hcl
module "fling" {
  source = "git::https://github.com/<owner>/fling.git//platforms/aws/infra?ref=<tag>"

  providers = { aws = aws, aws.us_east_1 = aws.us_east_1 } # CloudFront certificates live in us-east-1

  namespace     = "example"       # example-production-fling-*, /example/production/fling/
  env           = "production"
  bucket_prefix = "example-test-" # S3 bucket names are global
  hostname      = "fling.example.test"
  zone_id       = data.aws_route53_zone.this.zone_id
  github        = { owner = "example-org", owner_id = "1000001", repo = "fling", repo_id = "2000002" }
  instance      = { ALLOWED_EMAIL_DOMAINS = "example.test", OIDC_ISSUER = "...", OIDC_CLIENT_ID = "..." }
}
```

It also creates the live rooms' API Gateway WebSocket API ([`live.tf`](infra/live.tf): routes
`$connect`, `$default` and `$disconnect` to the same function, stage `live`, and lets the function
post to its connections); the function gets its `wss://` URL as `LIVE_URL` (output `live_url`).
Connections are table items that expire after 2 hours, API Gateway's own limit.

With `mail` set ([`mail.tf`](infra/mail.tf); see [Email](#email)), it also lets the function's role
send with SES (`ses:SendEmail` on the identity, and on the configuration set when one is named,
only from `mail.from`), sets `MAIL_DRIVER=ses`, `MAIL_FROM`, `MAIL_FROM_NAME`, `MAIL_REPLY_TO` and
`SES_CONFIGURATION_SET` on the function, and adds an EventBridge Scheduler schedule
(`<namespace>-<env>-<name>-notify`, `rate(1 minute)`) that invokes the function with
`{"fling":"notify"}` through its own role, to drain the notifications' outbox. It also adds
`/notifications/*` (the emails' unsubscribe page) to the app distribution's API paths, whatever
`api_paths` is. Without `mail`, none of it exists and the plan is the same as without the input.
`MAIL_*` and `SES_*` come only from `mail`: the module refuses them in `environment` and
`instance`, and the build refuses them in `INSTANCE`.

Needs Terraform 1.11 or later (the generated secrets are write-only, never in state) and the AWS
provider 6.x. Give it the provider twice: your region, and `us-east-1` as `aws.us_east_1`. Tag your
resources with the providers' `default_tags`.

| Input | Default | What |
| --- | --- | --- |
| `namespace` | (required) | Prefix of every name: `<namespace>-<env>-<name>-…`, and `/<namespace>/<env>/<name>/` for the log group and SSM |
| `env` | (required) | Environment, e.g. `production` |
| `name` | `fling` | The app's name in resource names |
| `bucket_prefix` | `""` | Prepended to the two bucket names (`…-ui`, `…-sites`), which must be globally unique |
| `hostname` | (required) | `$APP_DOMAIN`; sites are served on `*.<hostname>` (so here `$SITES_DOMAIN` = `$APP_DOMAIN`) |
| `zone_id` | (required) | Route 53 hosted zone for the two names (A/AAAA aliases) and the certificate's DNS validation |
| `github` | (required) | `{ owner, owner_id, repo, repo_id, environment = "production" }`: who may assume the deploy role. Ids are numeric (`gh api repos/<owner>/<repo> --jq '.owner.id, .id'`), so a renamed or re-created repository can't inherit trust |
| `github_oidc_provider_arn` | looked up | The account's IAM OIDC provider for `token.actions.githubusercontent.com` (one per account, so the module never creates it; create it once if you have none) |
| `instance` | `{}` | The [instance configuration](#instance-configuration), passed through as `INSTANCE` in the `deploy` output |
| `environment` | `{}` | Extra or overriding function environment variables. The module sets `APP_ENV=production`, `APP_ORIGIN`, `SITES_DOMAIN`, `SITE_SCHEME`, `SITE_COOKIE_DOMAIN`, the drivers and `NODE_OPTIONS` from `hostname`, `LIVE_URL` from the WebSocket stage, and always `TABLE_NAME`, `SITES_BUCKET`, `KVS_ARN`, `SSM_PREFIX` |
| `manual_secrets` | `["oidc-client-secret"]` | SSM parameters created as `unset`, for you to fill (see [Secrets](#secrets)) |
| `generated_secrets` | `["session-secret", "site-hmac-key"]` | SSM parameters Terraform generates, never in state |
| `secrets_version` | `1` | Bump to regenerate the generated secrets and `origin-verify-secret` |
| `enable_data_migrations` | `true` | The [data migrations](#data-migrations) grants: `lambda:InvokeFunction` on the function for the deploy role, `dynamodb:Scan` on the table for the function's role |
| `lambda` | Node 24, 512 MB, 30 s | `{ runtime, memory_size, timeout }` |
| `api_paths` | `/api/*`, `/auth/*`, `/healthz`, `/mcp`, `/mcp/*`, `/oauth/*`, `/.well-known/*` | App paths routed to the function, uncached. With `mail`, `/notifications/*` is added |
| `price_class` | `PriceClass_100` | CloudFront price class (Europe and North America edges) |
| `log_retention_days` | `30` | The function's log retention |
| `error_page_path` | `/_fling/404.html` | The sites' error page in the sites bucket (deploy.yml writes it) |
| `mail` | `null` (no email) | Email notifications through an SES identity you already have: `{ from, from_name, reply_to, identity_arn, configuration_set_name, events_topic_arn }`. See [Email](#email) |

| Output | What |
| --- | --- |
| `deploy` | The [deploy config](#the-deploy-config-aws_deploy_config): set it as the repository variable `AWS_DEPLOY_CONFIG` |
| `url` | `https://<hostname>` |
| `manual_secrets` | The SSM parameters you fill by hand |
| `ssm_prefix`, `table_name`, `function_name`, `key_value_store_arn`, `log_group` | For operating it (migrations, rehearsals, logs) |
| `notify_schedule` | The EventBridge Scheduler schedule that drains notifications every minute; `null` without `mail` |

Everything the remote MCP connector needs is part of it: DynamoDB TTL on `ttl`, the function's
access to `sites/*` and `uploads/*`, a lifecycle rule expiring `uploads/` after a day, and the app
distribution forwarding `POST` bodies and every viewer header but `Host` to the function.

**First apply.** Creating a public function URL can make AWS add the `FunctionURLAllowPublicAccess`
permission itself, and the apply then fails on the module's own copy ("The statement id
(FunctionURLAllowPublicAccess) provided already exists"). If it does, adopt it with the `import`
block commented out in the example, and apply again.

**Upgrading.** Bump the `ref` to a newer tag and read the plan. A release that changes the
infrastructure says so; most releases change only the code, which needs no apply.

**Adopting it from an existing stack.** The module's resource addresses are those of the module it
grew out of, so a stack that ran that module under the same `module` name switches with a plan of
"No changes" (keep `enable_data_migrations = false` for that first plan if the old module lacked
the grants, then turn it on). If your own resources sit at other addresses, add `moved` blocks
(`from` your address, `to` `module.<name>.<address>`) until the plan shows no replacements.

## The deploy config (AWS_DEPLOY_CONFIG)

`deploy.yml` needs one repository variable, `AWS_DEPLOY_CONFIG`: a JSON object, the module's
`deploy` output. Nothing in it is secret.

| Key | From | What |
| --- | --- | --- |
| `AWS_REGION` | the provider | Where the function, table and buckets are |
| `AWS_DEPLOY_ROLE_ARN` | `aws_iam_role.deploy` | Assumed over GitHub OIDC by the deploy job |
| `LAMBDA_FUNCTION` | `aws_lambda_function.api` | Updated with `lambda.zip`, invoked for migrations |
| `UI_BUCKET`, `SITES_BUCKET` | the buckets | The UI is synced to the first; the error page goes in the second |
| `SITE_ROUTER_FUNCTION` | `aws_cloudfront_function.site_router` | Updated and published with `edge/dist/site-router.js` (built by `edge/build.mjs`) |
| `APP_DISTRIBUTION_ID`, `SITES_DISTRIBUTION_ID` | the distributions | Invalidated after a deploy |
| `APP_ORIGIN` | `https://<hostname>` | The smoke test's target and the Claude Desktop extension's default server |
| `INSTANCE` | `var.instance` | The [instance configuration](#instance-configuration), written into `lambda.zip` as `instance.json`. Must have `ALLOWED_EMAIL_DOMAINS` or `ALLOWED_EMAILS` |

## Instance configuration

Everything that makes an instance *this* instance is configuration. The API publishes it at
`GET https://$APP_DOMAIN/.well-known/fling` (public, cached 5 minutes, CORS `*`); the CLI
(`fling login <url>`), the MCP servers and the web UI read it, so the published CLI, the Claude
plugin and the built UI work with any instance.

Values reach the function two ways, and the function's own environment wins:

1. **The function's environment**, from the module (the deployment plumbing: `APP_ORIGIN`,
   `SITES_DOMAIN`, `SITE_COOKIE_DOMAIN`, `TABLE_NAME`, `SITES_BUCKET`, `KVS_ARN`, `SSM_PREFIX`,
   `LIVE_URL`, `APP_ENV=production`; anything in its `environment` input).
2. **`instance.json` in `lambda.zip`**, written at deploy time from the `INSTANCE` object in
   `AWS_DEPLOY_CONFIG` (the module's `instance` input). Use it for the instance's identity: changing
   it needs a deploy, not an apply.

| Key | Required | What |
| --- | --- | --- |
| `ALLOWED_EMAIL_DOMAINS` | **yes**, unless `ALLOWED_EMAILS` is set (production refuses to start with neither; the deploy checks `INSTANCE` has one) | Comma-separated email domains that may sign in, e.g. `example.test`. A verified email whose domain matches one is admitted (and Google's `hd` claim, when present, must match its domain). |
| `ALLOWED_EMAILS` | **yes**, unless `ALLOWED_EMAIL_DOMAINS` is set | Comma-separated email addresses that may sign in whatever their domain, e.g. `you@gmail.com` for a personal instance. Each must still be verified. The addresses are never published: the public metadata only says there are invited accounts. With it set, Google's sign-in page gets no `hd` hint. |
| `ADMIN_EMAILS` | no (none) | Comma-separated email addresses of the instance's admins, who get **Admin** in the web UI: every user, and impersonation (acting as a user for up to 60 minutes, from a browser session only, audited); the mail page; and the instance's settings. Admins sign in like anyone else, so each must be admitted by `ALLOWED_EMAILS` or `ALLOWED_EMAIL_DOMAINS` (the function refuses to start otherwise); they get no other rights over anyone's sites. Checked on every request; never published. |
| `OIDC_ISSUER` | **yes**, with the next one (see [Sign-in](#sign-in-openid-connect)) | The OpenID Connect issuer, exactly as its tokens' `iss`, e.g. `https://accounts.google.com`. Must be `https`. |
| `OIDC_CLIENT_ID` | with `OIDC_ISSUER` | The client (application) id registered with the issuer. Its secret is the SSM parameter `oidc-client-secret`. |
| `OIDC_DISPLAY_NAME` | no (derived: Google, Microsoft, Okta, Auth0, else the issuer's host) | What the button says: "Sign in with …". |
| `OIDC_SCOPES` | no (`openid email profile`) | Space- or comma-separated scopes; must include `openid` and give an `email` claim. |
| `OIDC_ASSUME_EMAIL_VERIFIED` | no (`false`) | `true` treats an ID token *without* `email_verified` as verified. See [Sign-in](#sign-in-openid-connect). |
| `LIVE` | no (on) | `false` turns review mode's live rooms off (who else is looking, their pointers, comments appearing without a refresh). They also need comments on and `LIVE_URL`. |
| `LIVE_URL` | set by the platform | Where review pages open the live room's WebSocket, a `wss://` URL. The module sets it to the WebSocket API's stage (`live_url` output; [live.tf](infra/live.tf)); on Cloudflare the deploy sets `wss://<app host>/api/live`. Advertised only as the `live` capability, never published itself. |
| `MAIL_DRIVER` | no (none: no email) | Which mailer sends notification emails: `ses` (AWS) or `cloudflare` (Cloudflare), set by the platform from its mail settings. `file` (local dev, `.fling-dev/mail/`) and `memory` (tests, the e2e) are refused in production. With it, the `notifications` and `email` capabilities are on. |
| `MAIL_FROM` | with `MAIL_DRIVER` | The sender address, e.g. `fling@mail.example.test`, on a domain the provider may send from. In production its domain may not be the sites domain, nor a subdomain of it a site could hold: send from `mail.<sites domain>` or another domain. Never published. |
| `MAIL_FROM_NAME` | no (`INSTANCE_NAME`) | The sender's display name, one line. |
| `MAIL_REPLY_TO` | no (none) | The operator's address replies go to, on every email (never the person who acted). Never published. |
| `SES_CONFIGURATION_SET` | no (the identity's default) | AWS: the SES configuration set each send names. |
| `INVITES` | no (`off`) | `on` turns on outside invitations: people the email policy doesn't admit can be invited, and sign in with an emailed link. Needs email (`MAIL_DRIVER`): the function refuses to start with it on and no mail. See [Outside invitations](#outside-invitations). |
| `INVITES_PER_DAY` | no (`20`) | How many new outside addresses one person may invite a day, a positive whole number. |
| `INSTANCE_NAME` | no (`Fling`) | The name the UI, the CLI and the MCP descriptions show. |
| `SITE_DEFAULT_ACCESS` | no (`only_me`) | Who can open a new site whose first deploy names no access level: `only_me` (its owner alone) or `members` (everyone signed in). Published as `defaultAccess` in the metadata, so the CLI, the MCP servers and the web say who a new site is open to. It applies to sites created after the deploy that sets it; existing sites keep their access. |
| `INSTALL_COMMAND` | no (`npm install -g` + the CLI package) | How the Get started page tells people to install the CLI. |
| `BRAND_PRIMARY` | no | Hex colour behind primary buttons and active states, e.g. `#4f46e5`. |
| `BRAND_PRIMARY_CONTENT` | no | Hex colour of text on `BRAND_PRIMARY`. |
| `BRAND_ACCENT` | no | Hex colour of links and focus rings. |
| `BRAND_INK` | no | Hex colour of text and the dark chrome; the UI derives its greys and dark theme from it. |
| `BRAND_HIGHLIGHT` | no | Hex colour used decoratively (the animated thread, the sign-in wash). |
| `BRAND_LOGO_URL` | no | Logo mark shown before the name: an `https:` URL or a `data:image/…` URI (an SVG data URI keeps it self-contained). |
| `BRAND_LOGO_DARK_URL` | no | The same for the dark theme (defaults to `BRAND_LOGO_URL`). |
| `BRAND_FAVICON_URL` | no | Favicon, `https:` or `data:image/…`. |

Admins see every key here, the value the instance runs with and whether it was set or is the
default, at **Admin → Settings** in the web UI, with the [secrets](#secrets) by name only (set or
not, never their values). The page is read only: change a value here and redeploy.

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
policy: the ID token's `email` must be verified (`email_verified: true`) and either listed in
`ALLOWED_EMAILS` or on a domain in `ALLOWED_EMAIL_DOMAINS`.

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

**Restricted sites.** A private site with an audience is let in by a site pass, not the
`fling_site` cookie: the API checks the audience at sign-in, then the site router sets a host-only
`fling_pass` cookie (signed with the same key, good for 5 minutes) at `/_fling-pass` on the site's
host. That path is outside `_fling/*`, so the site router handles it. Someone the audience refuses
gets the same cookie saying so, for 10 seconds, and sees the 404 page at the address they asked for.
Taking someone out of an audience, or out of a group it names, shuts them out within 5 minutes;
adding someone lets them in within 10 seconds; nothing else needs configuring.

## One-time setup

1. **Infrastructure.** Call the module from your Terraform (see
   [Infrastructure](#infrastructure-the-terraform-module)) and apply. The account needs GitHub's
   OIDC provider (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`) once; the
   deploy role trusts it for `$GITHUB_REPO`'s `production` environment only. Until the first deploy
   the API answers 503.

2. **Sign-in client.** Register a web client with your OpenID Connect provider (see
   [Sign-in](#sign-in-openid-connect)) and store its secret in the SSM SecureString parameter
   `${SSM_PREFIX}oidc-client-secret` (the module created it as `unset`):

   ```bash
   aws ssm put-parameter --region "$AWS_REGION" --overwrite --type SecureString \
     --name "${SSM_PREFIX}oidc-client-secret" --value "file://client-secret.txt"
   ```

   The other secrets (`session-secret`, `site-hmac-key`,
   `origin-verify-secret`) are generated by Terraform.

3. **Redirect URI.** On that client, allow `https://$APP_DOMAIN/auth/callback`, and put
   `OIDC_ISSUER` and `OIDC_CLIENT_ID` in the `INSTANCE` object (next step).

4. **GitHub environment and config.** In the repository, create the environment `production`
   (Settings, Environments; deployment branches: `main` only). Then set the
   [deploy config](#the-deploy-config-aws_deploy_config) from the module's `deploy` output (with
   `INSTANCE` from its `instance` input):

   ```bash
   terraform output -json deploy | jq -c . | gh variable set AWS_DEPLOY_CONFIG -R "$GITHUB_REPO"
   ```

   If you keep the instance values out of Terraform (`instance` unset), add them here instead:
   `terraform output -json deploy | jq -c --argjson i "$(cat instance.json)" '. + {INSTANCE: $i}'`.
   Set it again whenever the output changes.

5. **npm trusted publishing (no token)**, only for the repository that publishes the CLI. Publish
   the very first version by hand (`npm login`, then `npm publish <tarball> --access public` from a
   `pnpm pack` of `apps/cli`). Then on npmjs.com open the package, go to **Settings → Trusted
   publishing**, add GitHub Actions with the repository's organization and name and the workflow
   `release-cli.yml`, and finally set **Publishing access → Require two-factor authentication and
   disallow tokens**. Every dependency is public, so installs need no token either.

6. **First deploy.** Push to `main`, or run the Deploy workflow by hand. Until then the API answers
   503, the UI bucket is empty and the site router passes requests straight through.

7. **Why Fling? (optional).** Signed in as an admin, publish the repository's `why/` page as a public
   site: `fling deploy why --name why-fling --access public`. Once it is live, the Get started page
   links to it (`GET /api/why`).

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
   with `FLING_MCPB_SERVER_URL=APP_ORIGIN` (the extension adds this Fling to the ones it knows when
   it starts; it is the same extension whichever Fling serves it), to `downloads/fling.mcpb`:
   `application/octet-stream`, served as an attachment, 5-minute cache. The UI sync excludes
   `downloads/*` so it doesn't delete the extension. The file has an extension, so the SPA function
   leaves it alone and it is served at `https://$APP_DOMAIN/downloads/fling.mcpb`.
3. Fills `__APP_ORIGIN__` in `apps/web/dist-404/404.html` and uploads it to
   `s3://<sites bucket>/_fling/404.html`. The sites distribution answers every S3 403 or 404 with it,
   as a 404; the page links home and brands itself from the app's `/.well-known/fling`. It does the
   same for the review shell (`apps/web/dist-review/review-shell.html` → `_fling/review.html`,
   `no-cache`), the page review mode frames on each site's own origin. The sites distribution's
   `_fling/*` behaviour serves both from the bucket without the site router and without a response
   headers policy, so nothing stops the app from framing the shell. Last, it uploads
   `apps/web/sites-robots.txt` to `_fling/robots.txt` (`text/plain`, 5-minute cache): the site
   router rewrites `/robots.txt` on every sites host to it (see
   [Indexing and share-link referrers](#indexing-and-share-link-referrers)).
4. Builds the site router (`edge/dist/site-router.js`: the shared routing decision,
   `packages/shared/src/site-routing.ts`, in a CloudFront Function shell), fills its
   `__APP_ORIGIN__` and `__SITE_SCHEME__`, updates the CloudFront Function (keeping its KeyValueStore association) and publishes it to LIVE.
5. Invalidates `/index.html` on the app distribution and `/_fling/*` on the sites distribution.

Site content is never touched by a deploy. Terraform ignores the code, so a plan after a deploy
reads "No changes".

## Email

Notification emails (someone shared a site with you, commented, added you to a group) go out
through Amazon SES v2, from an identity you own. Fling brings its own permission to send and the
addresses, nothing else: the identity, its DNS records, the configuration set and the account's
production access stay in your infrastructure, often shared with other apps. Without the module's
`mail` input there is no email, and nothing in Fling offers it.

### Bringing an identity

You need, in the function's region:

- a verified SES **domain identity** for the sender's domain. The domain must not be the sites
  domain itself: onboarding puts records on names under it, which would shadow the sites'
  wildcard. `mail.$SITES_DOMAIN` works (`mail` is a reserved site name, so it is never a site), as
  does any other domain you own. The function refuses to start with a sender on the sites domain;
- optionally a **configuration set**. Name it in `mail` to have every send use it; leave it out and
  the identity's default configuration set, if any, applies;
- **production access** in that region (below). Until then SES only delivers to verified
  addresses.

Then add `mail` to the module call and apply:

```hcl
module "fling" {
  # ...
  mail = {
    from                   = "fling@mail.fling.example.test"
    from_name              = "Example Fling"       # default: INSTANCE_NAME
    reply_to               = "help@example.test"   # default: none
    identity_arn           = "arn:aws:ses:eu-west-1:123456789012:identity/mail.fling.example.test"
    configuration_set_name = "fling-mail"          # default: the identity's own
  }
}
```

`events_topic_arn` (an SNS topic your configuration set publishes bounces and complaints to) is
accepted and not used yet: until Fling handles those events itself, SES's suppression list keeps
bounced and complaining addresses from being sent to again. SES accepts a send to a suppressed
address and drops it.

The function's role may send only from `from` (a `ses:FromAddress` condition), only through that
identity and configuration set. The function sends one `SendEmail` per recipient, with
`List-Unsubscribe` and one-click unsubscribe headers, and tags each message `fling-batch` (the
batch id, also in the `X-Fling-Batch` header) and `fling-events` (the event keys), which your
configuration set's event destinations can filter on.

### Creating an identity

If you have none, this is one way to make one, in your own Terraform beside the module call (the
names are examples; Route 53 is assumed):

```hcl
locals { mail_domain = "mail.fling.example.test" }

resource "aws_sesv2_configuration_set" "mail" {
  configuration_set_name = "fling-mail"
  suppression_options { suppressed_reasons = ["BOUNCE", "COMPLAINT"] }
  reputation_options { reputation_metrics_enabled = true }
}

# Easy DKIM: SES signs with a 2048-bit key; three CNAMEs publish it.
resource "aws_sesv2_email_identity" "mail" {
  email_identity         = local.mail_domain
  configuration_set_name = aws_sesv2_configuration_set.mail.configuration_set_name
}

resource "aws_route53_record" "dkim" {
  count   = 3
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "${aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${local.mail_domain}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

# A custom MAIL FROM domain, so SPF aligns with the From address for DMARC.
resource "aws_sesv2_email_identity_mail_from_attributes" "mail" {
  email_identity         = aws_sesv2_email_identity.mail.email_identity
  mail_from_domain       = "bounce.${local.mail_domain}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "bounce.${local.mail_domain}"
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.eu-west-1.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "bounce.${local.mail_domain}"
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "_dmarc.${local.mail_domain}"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@example.test"]
}
```

Then pass `aws_sesv2_email_identity.mail.arn` as `mail.identity_arn` and
`aws_sesv2_configuration_set.mail.configuration_set_name` as `mail.configuration_set_name`. SES
verifies the identity once the DKIM records resolve (`aws sesv2 get-email-identity
--email-identity mail.fling.example.test` shows `VerifiedForSendingStatus: true`). Start DMARC at
`p=none` if the domain sends mail from elsewhere too, and tighten it once the reports are clean.

### Production access

A new SES account is in the sandbox in each region: it sends only to verified addresses, at most
200 messages a day and 1 a second. The identity's owner requests production access once per
region, in the console (SES, Account dashboard, Request production access) or:

```sh
aws sesv2 put-account-details --region $AWS_REGION --production-access-enabled \
  --mail-type TRANSACTIONAL --website-url https://$APP_DOMAIN \
  --use-case-description "Notifications to signed-in members of our Fling instance: shares, comments, group changes. Each email has one-click unsubscribe."
aws sesv2 get-account --region $AWS_REGION --query '{production: ProductionAccessEnabled, quota: SendQuota}'
```

AWS answers within about 96 hours. Quotas (messages a day, a second) are per account and region,
counted in recipients; Fling defers a batch to the next UTC day when SES reports the daily quota
spent, and logs a warning the first time each day.

### Checking it

After the apply and a deploy, `/.well-known/fling` advertises the `email` capability. Sign in as an
admin, open **Admin → Mail** (`/admin/mail`), check the settings it shows and send a test email to
a real mailbox: it shows SES's message id or the mapped error (`rejected: MessageRejected` usually
means the identity is not verified or the account is in the sandbox). In the received message's
headers, check that SPF, DKIM and DMARC pass and align with the From domain. Fling never sends a
message to check the setup on its own.

## Outside invitations

By default only the people the email policy admits (`ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS`) and
`ADMIN_EMAILS` can sign in. `INVITES=on` lets people from outside in by invitation:

- **Sharing invites a guest.** Anyone signed in who adds an outside address to a site's audience or
  to a group invites that person as a guest: a reviewer who sees and comments on what is shared with
  them, and on public sites, and nothing else. Each person invites at most `INVITES_PER_DAY` (20 by
  default) new outside addresses a day; past it, the change is refused (`too_many_invites`).
- **Admins invite members** from **Admin → Invitations** (`/admin/invitations`): a full user, like
  anyone the policy admits. Revoking an invitation there cuts that person off on their next request.
- **Guests sign in with an emailed link**, single use, never at the OIDC issuer (which usually
  admits only your organisation): the share's notification email carries their first one, and the
  login page offers "Email me a sign-in link" for later.

It needs [Email](#email): the function refuses to start with `INVITES=on` and no mail. With it on,
`/.well-known/fling` advertises the `invites` capability and the clients show the invitation forms;
**Admin → Settings** shows the values the instance runs with. Turning it off again stops every
invitation counting at once (invited people are signed out on their next request); the invitation
records stay, and count again if it is turned back on.

## Indexing and share-link referrers

Sites are not indexed, and a share link's address (`s--<token>.<sites domain>`, the secret) is not
sent on as a Referer. What the site router can do on its own, at viewer-request:

- `/robots.txt` on every sites host, share links and unknown hosts included, is rewritten to
  `_fling/robots.txt` (`User-agent: *`, `Disallow: /`) before any lookup. A site's own
  `robots.txt` is never served. The object is in the sites bucket, so this needs no Terraform: the
  rewritten request goes to the same S3 origin, and a request for `/_fling/robots.txt` itself takes
  the `_fling/*` behaviour to the same object.
- The responses the router makes itself (the redirects to sign in, the trailing-slash 301, the
  405, the `/_fling-pass` redirects) say `X-Robots-Tag: noindex` on every sites host, and
  `Referrer-Policy: no-referrer` on a share host.
- The 404 page and the review shell say `noindex` and `no-referrer` in meta tags, on every host.

Known limits: a viewer-request function never sees the response, so the files S3 serves get
neither header. On a site-name host, `robots.txt` alone keeps them out of search engines. On a
share host the browser applies its default policy (`strict-origin-when-cross-origin`), so a page's
cross-origin requests send `Referer: https://s--<token>.<sites domain>/`. Adding the headers to
those responses takes infrastructure: the site router (or a second function) associated at
viewer-response on the sites distribution, adding `siteResponseHeaders(host)` from
`packages/shared/src/site-routing.ts`, or a response headers policy (which cannot tell share hosts
from site hosts, so it would set `no-referrer` on every site). Separately, on any platform, a page
can set its own `<meta name="referrer">`, which the browser obeys over the header.

## Rollback

Run the **Deploy** workflow by hand (Actions, Deploy, Run workflow) with `ref` set to an older commit
SHA of `main`. It rebuilds and redeploys that commit: API, UI, error page and site router together.
Old UI assets are still in the bucket, so nothing breaks while it runs.

Table items and KeyValueStore keys are not rolled back. Keep the data model backwards compatible, or
roll forward. Data migrations are written expand/contract so a rollback across one is survivable
(see [Data migrations](#data-migrations)); the one exception is a contract step, which is run by
hand and says so. A single site rolls back with `fling rollback <name> <versionId>`.

Rolling back to a release from before audiences: its API and site router ignore an audience, so a
restricted site is open to every signed-in member until you roll forward again (the audiences are
kept). Rolling back to a release from before groups keeps the groups but lets no one in through
them: a site whose audience names a group is shut to the group's members until you roll forward.

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

**Required permissions**: `lambda:InvokeFunction` on the function for the deploy role, and
`dynamodb:Scan` on the table for the function role. The module grants both unless
`enable_data_migrations = false`. Without them the deploy warns ("Data migrations NOT run") and
carries on; that is safe, as every migration is written so the code serves correctly before it has
run.

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
   pnpm --filter @fling/platform-aws migrate:rehearse --table "$COPY" --live-table "$TABLE" \
     --region "$AWS_REGION" --dry-run
   ```

4. **Rehearse** (runs the migrations on the copy, then verifies):

   ```bash
   pnpm --filter @fling/platform-aws migrate:rehearse --table "$COPY" --live-table "$TABLE" \
     --region "$AWS_REGION"
   ```

   It refuses to run on the live table: `--live-table` (the module's `table_name` output, or
   `FLING_LIVE_TABLE`) is required, and `--table` must be a different table with a different ARN.
   It prints the copy's `RestoreSummary` when AWS reports one, but doesn't require it (AWS has left
   it empty on a point-in-time restore). It must end `Verification: PASSED`, after
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

## Secrets

SSM SecureString parameters under `$SSM_PREFIX`, read by the function at cold start:

Admin → Settings lists each one under its environment name (`OIDC_CLIENT_SECRET`,
`SESSION_SECRET`, …), set or not, never its value.

| Parameter | Source |
| --- | --- |
| `oidc-client-secret` | Your OpenID Connect client's secret, put there by hand (One-time setup, step 2) |
| `google-client-id`, `google-client-secret` | Deprecated: read only when `OIDC_ISSUER` is unset, as the Google issuer (see [Sign-in](#sign-in-openid-connect)) |
| `session-secret`, `site-hmac-key` | Generated by Terraform, never in its state |
| `origin-verify-secret` | Generated by Terraform. CloudFront also sends it to the function URL as `X-Origin-Verify` |

To rotate the generated ones, bump the module's `secrets_version` and apply, then redeploy so warm
functions pick them up. Rotating `session-secret` signs everyone out. Rotating `site-hmac-key`
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

Live rooms are the one part billed per message. API Gateway WebSockets charge for connection
minutes and messages (about $0.25 per million minutes and $1 per million messages), and every
message a client sends, plus every connect and disconnect, is one Lambda invocation with a few
DynamoDB reads; relaying it to the others is a message each. Pointers are throttled in the client
to about 12 a second while someone moves the mouse over a reviewed page, so a busy review session
of a few people is thousands of invocations an hour. `LIVE=false` turns the rooms off.
Logs are kept for 30 days.

Email, with `mail` set: SES charges per message, $0.10 per 1,000 à la carte. Accounts created from
21 July 2026 start on the Essentials plan ($0.16 per 1,000), so switch to à la carte explicitly if
that is all you need. The every-minute schedule is about 43,000 invocations a month, well inside
EventBridge Scheduler's 14 million free ones, and each is a short Lambda invocation with a few
DynamoDB queries: pennies a month.
