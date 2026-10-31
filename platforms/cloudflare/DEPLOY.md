# Deploying Fling on Cloudflare

**Ask your agent:**

```text
Clone https://github.com/nearform/fling and follow platforms/cloudflare/DEPLOY.md
to install Fling on my Cloudflare account at fling.yourdomain.com.
Before you create or change anything, ask me for what you need
(the Cloudflare account and zone, and the sign-in provider) and show me the plan.
```

Or follow the steps below yourself.

Fling runs on Cloudflare as **one Worker** with a D1 database, an R2 bucket and a Workers KV
namespace. `scripts/setup.mjs` creates them once; `scripts/deploy.mjs` (run by the
`Deploy (Cloudflare)` workflow, or by hand) ships the code. One deployment is an **instance**: its
own hostnames, sign-in allowlist, name and look, all configuration, none of it in the code.

The examples use these placeholders; substitute your own:

| Placeholder | Example | What |
| --- | --- | --- |
| `$ZONE` | `example.com` | Your domain, a zone on the Cloudflare account |
| `$APP_HOST` | `fling.example.com` | The app (UI + API) |
| `$SITES_DOMAIN` | `fling.example.com` | Sites hang off it: `<name>.$SITES_DOMAIN` (may equal `$APP_HOST`; must sit under the app's registrable domain) |
| `$WORKER` | `fling` | The Worker; also names the resources (`fling` D1, `fling-sites` R2, `fling-routes` KV) |

```
$APP_HOST        Worker Custom Domain ─┬─ /api/*, /auth/*, /healthz, /mcp, /oauth/*,
                                       │  /.well-known/*       → the API core (Hono)
                                       ├─ GET /api/live        → the site's LiveRoom Durable
                                       │                         Object (WebSocket, live rooms)
                                       ├─ PUT /blob-upload/*   → signed uploads into R2
                                       └─ everything else      → the web UI (Static Assets)
*.$SITES_DOMAIN  Worker route ───────── the shared site routing decision
                                        (route table: KV, D1 on a miss) → R2
cron (hourly)    Worker scheduled ───── delete expired D1 items
cron (minutely)  Worker scheduled ───── drain the notifications' outbox → Email Service
                                        (send_email binding EMAIL; only with MAIL)
D1 $WORKER, R2 $WORKER-sites, KV $WORKER-routes, Durable Object class LiveRoom; secrets on the
Worker
```

The sites host runs the same routing function as the AWS CloudFront Function
(`packages/shared/src/site-routing.ts`): one place decides how a host and path become a site
version's file, a sign-in redirect or the 404 page.

Sites are not indexed and share links do not leak their address: `/robots.txt` on every sites host
is Fling's `Disallow: /` (`_fling/robots.txt` from the assets), in place of any the site has, and
the Worker adds the decision's headers to every sites-host response: `X-Robots-Tag: noindex`, and
`Referrer-Policy: no-referrer` on a share host (and `X-Fling-Version`, the version served, on a
site's files; `/_fling-version` answers with it on every platform). A page can still set its own
`<meta name="referrer">`, which the browser obeys over the header. On AWS the files S3 serves get
neither header (see
[Indexing and share-link referrers](../aws/DEPLOY.md#indexing-and-share-link-referrers)).

| Who | Owns |
| --- | --- |
| `scripts/setup.mjs` (once, with your Cloudflare login) | The D1 database, R2 bucket and KV namespace; the D1 schema; the Worker's secrets; your deploy config |
| You, in the dashboard | The sites' wildcard DNS record and, if needed, its certificate; for email, the sending domain in Email Service |
| `scripts/deploy.mjs` (the workflow) | The Worker's code, config, assets, routes and cron; D1 schema migrations; data migrations |
| The Worker at runtime | D1 items, KV route keys, site files in R2 |

## Requirements

- **Workers Paid plan** (from $5/month). A remote MCP publish hashes and scans up to 4 MB in one
  request: about 10-15 ms of CPU (`pnpm --filter @fling/platform-cloudflare bench:publish`), over
  the Free plan's 10 ms. `wrangler.jsonc` sets `limits.cpu_ms: 30000`, which only Paid allows.
- **A zone on the account** for `$APP_HOST` and `$SITES_DOMAIN`, both inside it.
- **The sites domain must be under the app's registrable domain** (`fling.example.com` and
  `*.fling.example.com`, or `fling.example.com` and `*.sites.example.com`): the app sets the
  `fling_site` cookie, which lets members open private sites, on the domain both share. The deploy
  sets `SITE_COOKIE_DOMAIN` to it.
- **A certificate for `*.$SITES_DOMAIN`.** Universal SSL covers `$ZONE` and `*.$ZONE` only. Sites
  one level further down (`*.fling.example.com`, the usual layout) need either:
  - an **Advanced Certificate** (Advanced Certificate Manager, $10/month): SSL/TLS → Edge
    Certificates → Order Advanced Certificate, hostnames `$SITES_DOMAIN` and `*.$SITES_DOMAIN`; or
    **Total TLS** (also part of ACM), which issues certificates for every proxied hostname; or
  - **a zone of its own** for the instance, with the app on the apex and sites one level down
    (`$ZONE=flingsites.example`, `$APP_HOST=$SITES_DOMAIN=flingsites.example`): Universal SSL
    covers both, at no cost.
- Node 24 and pnpm (the repository's), and `wrangler` comes with `pnpm install`.
- **For email notifications (optional): Cloudflare Email Service**, Email Sending, in public beta.
  It sends to any recipient once a sending domain is onboarded, and that domain must use
  Cloudflare DNS. Workers Paid, which Fling already needs, is required. Without it, leave `MAIL`
  out of the deploy config: there is no email.

## One-time setup

1. **Sign in** with wrangler as someone who can create Workers, D1, R2 and KV on the account:
   `pnpm --filter @fling/platform-cloudflare exec wrangler login` (or set `CLOUDFLARE_API_TOKEN`).
2. **Run the setup script** (asks for anything not passed; safe to run again):

   ```bash
   pnpm --filter @fling/platform-cloudflare setup -- \
     --account-id <account id> --worker fling --zone example.com \
     --app-host fling.example.com --sites-domain fling.example.com \
     --email-domains example.com --instance-name "Fling" \
     --oidc-issuer https://accounts.google.com --oidc-client-id <client id> --location weur
   ```

   For a personal instance, admit individual addresses with `--allowed-emails you@gmail.com`
   instead of (or as well as) `--email-domains`. `--admin-emails you@example.com` (optional, not
   asked for; `''` removes them) makes those users the instance's admins (`ADMIN_EMAILS`).
   `--site-default-access members` (optional, not asked for; `''` removes it) opens new sites to
   everyone signed in, where the default is only their owner (`SITE_DEFAULT_ACCESS`).
   `--invites on` (optional, not asked for; `''` removes it) turns on outside invitations
   (`INVITES`), which need [Email](#email): the deploy refuses `INVITES` on without `MAIL`.
   `--invites-per-day 20` sets how many new outside addresses a person may invite a day
   (`INVITES_PER_DAY`).

   It creates the D1 database (`--location` is a placement hint), the R2 bucket and the KV
   namespace unless they exist, writes the deploy config to `--out` (nothing in it is secret, but
   it is the instance's, not Fling's: point `--out` at the instance's own private repository, e.g.
   `--out ../my-instance-infra/cloudflare/deploy-config.json`; the default,
   `platforms/cloudflare/deploy-config.json`, is gitignored) and the deployable `dist/wrangler.jsonc`, applies the D1 schema, and sets the Worker's missing secrets:
   `SESSION_SECRET` and `SITE_HMAC_KEY` (random) and `OIDC_CLIENT_SECRET` (asked for, never echoed;
   leave it blank to set it later with `wrangler secret put OIDC_CLIENT_SECRET --config
   dist/wrangler.jsonc`). Secrets are only ever added: rerunning it keeps the existing ones.
3. **DNS for the sites**: in the zone, a proxied record covering the wildcard, e.g.
   `*.fling` (that is, `*.$SITES_DOMAIN`) `AAAA 100::`, **Proxied**. The Worker answers it through
   its route `*.$SITES_DOMAIN/*`; `100::` is a placeholder that never receives traffic. The app
   hostname needs no record: it is a Worker Custom Domain, created with its DNS record and
   certificate by the first deploy (it must not already have a DNS record).
4. **Certificate for the sites** (see Requirements), unless `*.$SITES_DOMAIN` is `*.$ZONE`.
5. **Sign-in**: register the OIDC client (next section) and put its secret on the Worker.
6. **Email** (optional): onboard a sending domain and add `MAIL` to the deploy config
   ([Email](#email)).
7. **GitHub** (repository → Settings → Environments → `cloudflare`, or repository-level):
   - variable `CF_DEPLOY_CONFIG`: the contents of `deploy-config.json`
     (`gh variable set CF_DEPLOY_CONFIG < <path to deploy-config.json>`);
   - secret `CLOUDFLARE_API_TOKEN`: an account API token (My Profile or Manage Account → API
     Tokens) with **Account**: Workers Scripts Edit, D1 Edit, Workers KV Storage Edit, Workers R2
     Storage Edit, Account Settings Read; **Zone** (`$ZONE`): Workers Routes Edit, DNS Edit (the
     Custom Domain's record), Zone Read. If wrangler reports another missing permission, add it;
   - secret `FLING_E2E_API_KEY` after the first deploy (see [Smoke test](#smoke-test)).
8. **Deploy**: run the **Deploy (Cloudflare)** workflow (Actions → Deploy (Cloudflare) → Run
   workflow), or from a checkout of main:

   ```bash
   pnpm install && pnpm --filter "@fling/web..." build
   pnpm --filter @fling/platform-cloudflare run deploy --config-file "$PWD/<path to deploy-config.json>"
   ```

Then open `https://$APP_HOST`, sign in, and `fling login https://$APP_HOST`.
Optionally, publish the repository's `why/` page as a public site, `fling deploy why --name why-fling
--access public`: once it is live, the Get started page links to it.

## The deploy config (CF_DEPLOY_CONFIG)

The counterpart of AWS's `AWS_DEPLOY_CONFIG`: one JSON object, written by `setup.mjs`, read by
`scripts/render-config.mjs` to turn the template `wrangler.jsonc` into `dist/wrangler.jsonc`.
Nothing in it is secret.

| Key | What |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | The account the Worker and its resources are in |
| `WORKER_NAME` | The Worker |
| `ZONE_NAME` | The zone of both hostnames (the sites route is attached to it) |
| `APP_ORIGIN` | `https://$APP_HOST`, a Worker Custom Domain |
| `SITES_DOMAIN` | `$SITES_DOMAIN`; the route is `*.$SITES_DOMAIN/*` |
| `D1_DATABASE_NAME`, `D1_DATABASE_ID` | The D1 database |
| `R2_BUCKET` | The R2 bucket for site files |
| `KV_NAMESPACE_ID` | The KV namespace for routes |
| `INSTANCE` | The instance's own values, as on AWS: `ALLOWED_EMAIL_DOMAINS` and/or `ALLOWED_EMAILS` (at least one), `ADMIN_EMAILS` (optional), `OIDC_*`, `INSTANCE_NAME`, `SITE_DEFAULT_ACCESS` (optional), `INVITES` and `INVITES_PER_DAY` (optional; `INVITES` on needs `MAIL`), `BRAND_*`, … ([the table in the AWS guide](../aws/DEPLOY.md#instance-configuration)). They become the Worker's vars. Mail settings (`MAIL_*`, `SES_*`) are refused here: they go in `MAIL` |
| `MAIL` | Optional: `{ "FROM": "fling@mail.fling.example.com", "FROM_NAME": "Example Fling", "REPLY_TO": "help@example.com" }`, email notifications through Email Service ([Email](#email)). `FROM` is required in it; `FROM_NAME` defaults to `INSTANCE_NAME`, `REPLY_TO` to none. Not in `INSTANCE`, because the binding needs `FROM` too. `setup.mjs` keeps it when rerun |

The rendered config replaces the template's local-development vars wholesale: production gets
`APP_ENV=production`, `APP_ORIGIN`, `SITES_DOMAIN`, `SITE_SCHEME=https`, `SITE_COOKIE_DOMAIN` (the
domain the app and the sites share), `LIVE_URL=wss://$APP_HOST/api/live` (the live rooms, below),
the `d1`/`r2`/`workers-kv` drivers, and `INSTANCE`, never the dev login. `LIVE=false` in `INSTANCE`
turns the live rooms off. With `MAIL` it also gets the `send_email` binding `EMAIL`
(`allowed_sender_addresses: [FROM]`), the every-minute cron `* * * * *` beside the hourly one, and
`MAIL_DRIVER=cloudflare`, `MAIL_FROM`, `MAIL_FROM_NAME` and `MAIL_REPLY_TO`; without it, none of
them.

**Live rooms** (review mode's realtime) are a Durable Object per site, `LiveRoom` (binding
`LIVE_ROOMS`), declared with its SQLite migration in `wrangler.jsonc`: the first deploy creates the
class, nothing to set up. The Worker checks the socket's ticket and hands it to the site's object,
which keeps it with the WebSocket hibernation API, so an idle room costs nothing while sockets stay
open. Changing an instance value is a deploy.

## Email

Notification emails (someone shared a site with you, commented, added you to a group) go out
through Cloudflare Email Service's `send_email` binding. Every minute the Worker's cron drains the
notifications' outbox and sends each message with the binding, from `MAIL.FROM`.

1. **Onboard a sending domain** (once, in the dashboard: Email Service → Email Sending → Onboard
   Domain). It is not the sites domain itself: onboarding adds records under the domain (SPF and MX
   on a `cf-bounce` subdomain, DKIM, DMARC), which on the sites domain would shadow the sites'
   wildcard and break a site of the same name. Use `mail.$SITES_DOMAIN` (`mail` is a reserved site
   name, so it is never a site), or another domain on the account. The Worker refuses to start with
   a sender on the sites domain. Onboarding has no API or wrangler command, so this step is the
   dashboard's.
2. **Add `MAIL`** to the deploy config, with `FROM` on that domain, update `CF_DEPLOY_CONFIG`, and
   deploy:

   ```json
   "MAIL": { "FROM": "fling@mail.fling.example.com", "FROM_NAME": "Example Fling", "REPLY_TO": "help@example.com" }
   ```

3. **Check it**: `/.well-known/fling` advertises the `email` capability. Sign in as an admin, open
   **Admin → Mail** (`/admin/mail`) and send a test email to a real mailbox. It shows Email
   Service's message id or the mapped error: `E_SENDER_NOT_VERIFIED` or
   `E_SENDER_DOMAIN_NOT_AVAILABLE` mean the domain is not onboarded (or `FROM` is not on it). In the
   received message's headers, check that SPF, DKIM and DMARC pass. Fling never sends a message to
   check the setup on its own.

Email Service suppresses hard-bouncing addresses itself and refuses a send to one
(`E_RECIPIENT_SUPPRESSED`), which Fling records as suppressed for 30 days. Its daily quota starts conservative
and grows, and is not published; when it is spent (`E_DAILY_LIMIT_EXCEEDED`), Fling defers the
batch to the next UTC day and logs a warning the first time each day. Each message carries
`List-Unsubscribe` and one-click unsubscribe headers and the batch id in `X-Fling-Batch`.

## Outside invitations

As on AWS ([Outside invitations](../aws/DEPLOY.md#outside-invitations)): `INVITES=on` lets people
from outside the email policy in by invitation. Sharing a site or adding someone to a group with an
outside address invites them as a guest (a reviewer of what is shared with them), at most
`INVITES_PER_DAY` new addresses a day per person (default 20); admins invite full members and revoke
invitations at **Admin → Invitations**. A revocation also goes on the edge's revocation list, which
the Worker reads from KV alone (a D1 read for every member's page view would cost too much), so a
revoked member's `fling_site` cookie stops opening members-level sites everywhere within about a
minute; the one-minute cron takes entries off the list after 30 days. Invited people sign in with single-use links emailed to
them, so it needs [Email](#email): the deploy refuses `INVITES` on without `MAIL`. Set both with
`setup.mjs` (`--invites on`, `--invites-per-day`) or in `INSTANCE` in the deploy config, then deploy.

## Sign-in (OpenID Connect)

Exactly as on AWS ([Sign-in](../aws/DEPLOY.md#sign-in-openid-connect): Google, Entra ID, Okta,
Auth0), except where the secret lives. Register a confidential web client with the redirect URI
`https://$APP_HOST/auth/callback` and scopes `openid email profile`, set `OIDC_ISSUER` and
`OIDC_CLIENT_ID` in `INSTANCE` (setup's `--oidc-issuer`/`--oidc-client-id`), and put the client
secret on the Worker:

```bash
cd platforms/cloudflare
pnpm exec wrangler secret put OIDC_CLIENT_SECRET --config dist/wrangler.jsonc
```

## How a deploy ships

`scripts/deploy.mjs`, in this order, so nothing is served that points at something missing:

1. renders `dist/wrangler.jsonc` from the template and `CF_DEPLOY_CONFIG`, and builds the Claude
   Desktop extension (`apps/cli` `build:mcpb`) with the instance's address baked in
   (`FLING_MCPB_SERVER_URL`): the extension adds this Fling to the ones it knows when it starts. It
   is the same extension whichever Fling serves it, so installing it from another updates it;
2. assembles `dist/assets`: the web UI (`apps/web/dist`), the sites' 404 page at `_fling/404.html`
   and the review shell at `_fling/review.html` (the Worker fills their `__APP_ORIGIN__` when
   serving them), every sites host's robots.txt at `_fling/robots.txt` and the extension at `downloads/fling.mcpb` (a deploy without it stops here);
   then bundles the Worker without deploying it and checks the bundle (no
   AWS SDK, under 10 MB);
3. applies the D1 schema migrations (`migrations/*.sql`, `wrangler d1 migrations apply --remote`).
   They are additive, so the running code keeps working;
4. deploys the Worker with its assets, routes, cron and vars (`wrangler deploy`). Unlike the AWS
   UI bucket, the previous release's hashed files go with it: a tab left open across a deploy may
   need a reload to load a lazy chunk;
5. runs Fling's data migrations (below);
6. waits until `https://$APP_HOST/.well-known/fling` answers for this instance;
7. runs the smoke test.

The web UI: `index.html` (and every client-side route) is `no-cache`, `/assets/*` (content-hashed)
`immutable` for a year, other files five minutes, with the same security headers the AWS
distribution adds.

## Data migrations

The same migrations as every platform (`apps/api/src/migrations`, idempotent, checkpointed in
`MIGRATION#…` items), run by `scripts/migrate.ts` **from the deploy job**, not by the Worker: it
binds the D1 database through wrangler's remote bindings (proxied to the real database with the
deploy's API token) and runs the runner over the same `D1Table` the Worker uses. So there is no
admin endpoint on the Worker and no extra secret, and a long migration isn't bound by a request's
CPU limit. They run after the code, as on AWS: the code tolerates pending migrations.

By hand (a dry run first):

```bash
cd platforms/cloudflare
CF_DEPLOY_CONFIG="$(cat deploy-config.json)" node scripts/render-config.mjs
pnpm migrate --remote --config dist/wrangler.jsonc --dry-run
pnpm migrate --remote --config dist/wrangler.jsonc [--only 0002]
```

## Smoke test

The deploy ends with the e2e scenario (`packages/e2e`) against the live instance: deploy a site
with the CLI, view it, a trailing-slash redirect and the 404 page, a second version and a rollback,
make it private (anonymous visitors are sent to sign in), a share link, four concurrent first
deploys of one name (conditional writes: exactly one site), an MCP publish, then it removes the
three sites it made (`e2e-<random>…`). With `MAIL`, the instance advertises the `email` capability
and the test checks that the notification settings (`GET /api/me/notifications`) answer; it sends
no email. What each person is sent is checked by the local e2e, which can drain the outbox at once
(`POST /dev/notify/drain`, dev login only).

It signs in with an API key: as a test user that `ALLOWED_EMAIL_DOMAINS` or `ALLOWED_EMAILS` admits, run
`FLING_CONFIG_DIR=$(mktemp -d) fling login https://$APP_HOST` and take the server's `apiKey`
(under `servers`) from the `config.json` in that directory (revoke it any time on the web UI's API keys page), and store it as
the `FLING_E2E_API_KEY` secret. Without it the deploy warns and skips the test. By hand:

```bash
FLING_E2E_API_KEY=fling_… pnpm --filter @fling/e2e smoke https://$APP_HOST
```

`FLING_E2E_ADMIN_API_KEY`, a key of a user in `ADMIN_EMAILS`, adds the admin checks an API key
can make (the users list; reading the test user's site, but not changing it; impersonation
refused, as it is for any API key). Without it they are skipped; impersonation and an admin's
changes to someone else's site are covered by the local e2e, which has browser sessions.
With `FLING_E2E_MEMBER_API_KEY` (a second test user) and `FLING_E2E_OUTSIDER_API_KEY` (a third, not
an admin), the smoke test also restricts its site to the member and checks through the API that
the outsider finds no such site, then lets them in through a group the member makes (and shuts
them out again). Without the outsider, the admin, who reads any site, checks the way in only. The
site pass itself needs browser sessions, so the local e2e follows it.

## Routes, consistency and the KV fallback

Every request goes to the Worker first (`run_worker_first`), so a site's paths can never hit the
app's assets. The sites host reads the route table on every request. Workers KV is fast but
eventually consistent: other locations can see a write 60 seconds or more later, and a location
that just read a key (a miss included) keeps the old answer about as long. So the routes are also
kept in D1, written first, and **a KV miss is answered from D1**: a new site or share link works
everywhere as soon as the API has written it, so the CLI and the MCP tools never wait on KV, and
the CLI's readiness check (`ready.ts`) has nothing new to wait for. What KV can still show for up
to about a minute is a change to an existing key: a rollback or redeploy (the previous version),
a visibility change, an archived site, a rotated or revoked share link, a site becoming
restricted or open again (its audience changing from or to empty).

**Restricted sites** (private with an audience) are let in by a site pass: the app checks the
audience at sign-in and the Worker sets a host-only `fling_pass` cookie, good for 5 minutes.
Someone the audience refuses gets the same cookie saying so, for 10 seconds, and sees the 404 page
at the address they asked for, so adding someone lets them in within 10 seconds. Taking someone
out of an audience, or out of a group it names, shuts them out within 5 minutes (plus the KV delay
above when it was the last person and the site opens to every member again).

## Rollback

Run the workflow with an earlier commit of main as `ref`. The Worker, its assets and its config go
back; D1 schema and data migrations don't (they are forward-only and written so older code keeps
working), and neither does site content. `wrangler rollback` also works for the code alone.
Rolling back to a release from before audiences opens restricted sites to every signed-in member
until you roll forward again (the audiences are kept). Rolling back to a release from before groups
lets no one in through a group: a site whose audience names one is shut to its members until you
roll forward.

## Local development

```bash
pnpm --filter "@fling/web..." build   # the Worker serves the built UI
pnpm --filter @fling/platform-cloudflare dev
```

`scripts/dev.mjs` applies the D1 schema and the data migrations to local state
(`.wrangler/state`), then runs `wrangler dev`: the app at `http://flingcf.lvh.me:47103`, sites at
`http://<name>.flingcf.lvh.me:47103`, dev login on, local D1/R2/KV (nothing touches your account).
Secrets come from `.dev.vars`, created with random values the first time. The live rooms run in
local Durable Objects at `ws://flingcf.lvh.me:47103/api/live`. `pnpm e2e` (part of
`pnpm gate`) runs the scenario here and on the AWS-flavoured dev server.

`wrangler dev` simulates the `send_email` binding (`EMAIL`, in the template `wrangler.jsonc`):
it accepts any recipient, logs each message's From, To and Subject, and saves its text and HTML
parts to local files whose paths it prints. Nothing is sent. To turn email on locally, run
`pnpm --filter @fling/platform-cloudflare dev --mail` (it sets `MAIL_DRIVER=cloudflare` and
`MAIL_FROM=fling@mail.flingcf.lvh.me`; the same two lines in `.dev.vars` do it too). The real
`CloudflareMailer` then sends through the simulated binding. `wrangler dev` runs no crons, so
`POST /dev/notify/drain` sends what is queued, including what is due within the hour. The e2e runs
this runtime with `--mail`.

## Costs

At internal scale, mostly the fixed parts: the Workers Paid plan ($5/month, with 10 million
requests and 30 million CPU-milliseconds a month) and, for a two-level sites wildcard, Advanced
Certificate Manager ($10/month). Every site and UI request is a Worker request (the Worker runs
first), plus a KV read per site request. D1, R2 and KV are billed by use beyond generous included
amounts: D1 by rows read and written and storage, R2 by storage (about $0.015 per GB-month, the main
variable cost: every site version is kept) and operations, with no egress fees; KV by reads and
writes. Live rooms are Durable Object requests (each socket message, each publish when a comment
changes) and duration, which hibernation keeps to the moments a room is busy. Email, with `MAIL`:
3,000 emails a month are included, then $0.35 per 1,000 (hard bounces count, refused sends such as
suppressed recipients don't); the every-minute cron is a short Worker invocation each time, about
43,000 a month. Check Cloudflare's current pricing pages before relying on these numbers.
