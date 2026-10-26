# Deploying Fling on Cloudflare

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
D1 $WORKER, R2 $WORKER-sites, KV $WORKER-routes, Durable Object class LiveRoom; secrets on the
Worker
```

The sites host runs the same routing function as the AWS CloudFront Function
(`packages/shared/src/site-routing.ts`): one place decides how a host and path become a site
version's file, a sign-in redirect or the 404 page.

| Who | Owns |
| --- | --- |
| `scripts/setup.mjs` (once, with your Cloudflare login) | The D1 database, R2 bucket and KV namespace; the D1 schema; the Worker's secrets; your deploy config |
| You, in the dashboard | The sites' wildcard DNS record and, if needed, its certificate |
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
6. **GitHub** (repository → Settings → Environments → `cloudflare`, or repository-level):
   - variable `CF_DEPLOY_CONFIG`: the contents of `deploy-config.json`
     (`gh variable set CF_DEPLOY_CONFIG < <path to deploy-config.json>`);
   - secret `CLOUDFLARE_API_TOKEN`: an account API token (My Profile or Manage Account → API
     Tokens) with **Account**: Workers Scripts Edit, D1 Edit, Workers KV Storage Edit, Workers R2
     Storage Edit, Account Settings Read; **Zone** (`$ZONE`): Workers Routes Edit, DNS Edit (the
     Custom Domain's record), Zone Read. If wrangler reports another missing permission, add it;
   - secret `FLING_E2E_API_KEY` after the first deploy (see [Smoke test](#smoke-test)).
7. **Deploy**: run the **Deploy (Cloudflare)** workflow (Actions → Deploy (Cloudflare) → Run
   workflow), or from a checkout of main:

   ```bash
   pnpm install && pnpm --filter "@fling/web..." build
   pnpm --filter @fling/platform-cloudflare run deploy -- --config-file "$PWD/<path to deploy-config.json>"
   ```

Then open `https://$APP_HOST`, sign in, and `fling login https://$APP_HOST`.

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
| `INSTANCE` | The instance's own values, as on AWS: `ALLOWED_EMAIL_DOMAINS` and/or `ALLOWED_EMAILS` (at least one), `ADMIN_EMAILS` (optional), `OIDC_*`, `INSTANCE_NAME`, `BRAND_*`, … ([the table in the AWS guide](../aws/DEPLOY.md#instance-configuration)). They become the Worker's vars |

The rendered config replaces the template's local-development vars wholesale: production gets
`APP_ENV=production`, `APP_ORIGIN`, `SITES_DOMAIN`, `SITE_SCHEME=https`, `SITE_COOKIE_DOMAIN` (the
domain the app and the sites share), `LIVE_URL=wss://$APP_HOST/api/live` (the live rooms, below),
the `d1`/`r2`/`workers-kv` drivers, and `INSTANCE`, never the dev login. `LIVE=false` in `INSTANCE`
turns the live rooms off.

**Live rooms** (review mode's realtime) are a Durable Object per site, `LiveRoom` (binding
`LIVE_ROOMS`), declared with its SQLite migration in `wrangler.jsonc`: the first deploy creates the
class, nothing to set up. The Worker checks the socket's ticket and hands it to the site's object,
which keeps it with the WebSocket hibernation API, so an idle room costs nothing while sockets stay
open. Changing an instance value is a deploy.

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

1. renders `dist/wrangler.jsonc` from the template and `CF_DEPLOY_CONFIG`;
2. assembles `dist/assets`: the web UI (`apps/web/dist`), the sites' 404 page at `_fling/404.html`
   and the review shell at `_fling/review.html` (the Worker fills their `__APP_ORIGIN__` when
   serving them) and, when built,
   `downloads/fling.mcpb`; then bundles the Worker without deploying it and checks the bundle (no
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
three sites it made (`e2e-<random>…`).

It signs in with an API key: as a test user that `ALLOWED_EMAIL_DOMAINS` or `ALLOWED_EMAILS` admits, run
`FLING_CONFIG_DIR=$(mktemp -d) fling login https://$APP_HOST` and take `apiKey` from the
`config.json` in that directory (revoke it any time on the web UI's API keys page), and store it as
the `FLING_E2E_API_KEY` secret. Without it the deploy warns and skips the test. By hand:

```bash
FLING_E2E_API_KEY=fling_… pnpm --filter @fling/e2e smoke https://$APP_HOST
```

`FLING_E2E_ADMIN_API_KEY`, a key of a user in `ADMIN_EMAILS`, adds the admin checks an API key
can make (the users list; impersonation refused, as it is for any API key). Without it they are
skipped; impersonation itself is covered by the local e2e, which has browser sessions.

## Routes, consistency and the KV fallback

Every request goes to the Worker first (`run_worker_first`), so a site's paths can never hit the
app's assets. The sites host reads the route table on every request. Workers KV is fast but
eventually consistent: other locations can see a write 60 seconds or more later, and a location
that just read a key (a miss included) keeps the old answer about as long. So the routes are also
kept in D1, written first, and **a KV miss is answered from D1**: a new site or share link works
everywhere as soon as the API has written it, so the CLI and the MCP tools never wait on KV, and
the CLI's readiness check (`ready.ts`) has nothing new to wait for. What KV can still show for up
to about a minute is a change to an existing key: a rollback or redeploy (the previous version),
a visibility change, an archived site, a rotated or revoked share link.

## Rollback

Run the workflow with an earlier commit of main as `ref`. The Worker, its assets and its config go
back; D1 schema and data migrations don't (they are forward-only and written so older code keeps
working), and neither does site content. `wrangler rollback` also works for the code alone.

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

## Costs

At internal scale, mostly the fixed parts: the Workers Paid plan ($5/month, with 10 million
requests and 30 million CPU-milliseconds a month) and, for a two-level sites wildcard, Advanced
Certificate Manager ($10/month). Every site and UI request is a Worker request (the Worker runs
first), plus a KV read per site request. D1, R2 and KV are billed by use beyond generous included
amounts: D1 by rows read and written and storage, R2 by storage (about $0.015 per GB-month, the main
variable cost: every site version is kept) and operations, with no egress fees; KV by reads and
writes. Live rooms are Durable Object requests (each socket message, each publish when a comment
changes) and duration, which hibernation keeps to the moments a room is busy. Check Cloudflare's
current pricing pages before relying on these numbers.
