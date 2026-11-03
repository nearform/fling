<!-- markdownlint-disable MD013 -->

# Developing Fling

Terms are defined in [CONTEXT.md](../CONTEXT.md), and the binding rules are in
[.claude/rules/](../.claude/rules/). This guide covers the day-to-day work: running Fling locally
and making the common kinds of change.

## Setup

You need Node 24 (`.nvmrc`) and pnpm 10 (`packageManager`). Docker and terraform are optional.

```sh
pnpm install
pnpm gate     # lint (Biome, de-branding check), terraform validate, typecheck, test, build, e2e
```

CI runs `pnpm gate` and nothing else, so if it passes locally it passes in CI. The one exception is
the suites backed by DynamoDB Local and MinIO, which run only when their endpoints are set. To run
them locally:

```sh
docker run -d -p 8000:8000 amazon/dynamodb-local
docker run -d -p 9000:9000 -e MINIO_ROOT_USER=fling-test \
  -e MINIO_ROOT_PASSWORD=fling-test-secret bitnamilegacy/minio
FLING_TEST_DYNAMODB_ENDPOINT=http://localhost:8000 \
  FLING_TEST_S3_ENDPOINT=http://localhost:9000 pnpm --filter @fling/platform-aws test
```

Without terraform installed, the terraform check is skipped outside CI.

## Running locally

There are two local runtimes, and each serves the whole product:

| Runtime | Start | App | Sites |
|---|---|---|---|
| Core on Node (AWS flavoured: memory table, fs blobs, the real CloudFront Function) | `pnpm dev`, plus `pnpm --filter @fling/web dev` for the UI | <http://fling.lvh.me:47100> (API :47101) | `http://<name>.fling.lvh.me:47102` |
| Cloudflare Worker under `wrangler dev` (local D1, R2, KV) | `pnpm --filter "@fling/web..." build`, then `pnpm --filter @fling/platform-cloudflare dev` | <http://flingcf.lvh.me:47103> | `http://<name>.flingcf.lvh.me:47103` |

`lvh.me` resolves to 127.0.0.1. Both runtimes run pending data migrations on start, as a deploy
does. Node keeps its state in `.fling-dev/` and wrangler in `platforms/cloudflare/.wrangler/`.
Delete either folder to start over.

**Pages on site hosts.** The sites' 404 page and the review shell (`/_fling/review.html`, the page
review mode frames) are single-file builds of `apps/web` (`vite.404.config.ts`,
`vite.review-shell.config.ts`), served on every site host by both runtimes. Run
`pnpm --filter @fling/web build` before trying them locally, and again after changing them. Both
say `noindex` and `no-referrer` in meta tags, since share hosts serve them too. The site page's
preview is the review shell in preview mode (`?mode=preview`), so it needs the same build. Open a
site's page signed in as its owner and the preview draws its thumbnail and uploads it (the request
is `PUT /api/sites/<name>/thumbnail` in the browser's network panel, after a `HEAD /_fling-version`
on the site's host that says the current version); the Sites page then shows it,
as rows or in the grid. Drawing happens in the browser only, so the e2e scenario uploads a made-up
PNG instead. Every sites host's
`/robots.txt` is `apps/web/sites-robots.txt`, served as is.

**Signing in.** Local dev uses a dev login form: any `@example.test` address gets in, and
`admin@example.test` is an admin. The metadata publishes the allowed domains as for OIDC
(`auth.emailDomains`), so the web's email inputs complete them. New sites are visible only to
their owner (`SITE_DEFAULT_ACCESS` unset); `SITE_DEFAULT_ACCESS=members pnpm dev` opens them to
everyone signed in, and `pnpm cli deploy <folder> --access members` does so for one site. To try an audience, restrict a site to another `@example.test` address
(`pnpm cli access <site> --add b@example.test`) and open it signed in as each in two browser
profiles: the audience gets in through a site pass, anyone else sees the 404 page. Groups work the
same way (`pnpm cli groups create team --add b@example.test`, then `pnpm cli access <site> --group
team`). Signed in as the other address, `pnpm cli ls --shared` (or the Sites page's Shared with
me tab) lists what was shared with it. Owners and publishers work the same way: `pnpm cli
publishers <site> --add b@example.test` lets the other address deploy the site and roll it back
(the site page shows it the read-only Owners and publishers section, and no Access or danger zone),
and `pnpm cli owners <site> --add b@example.test` makes it a co-owner. `pnpm cli deploy <folder>
--name <site> --path 30-10-26` publishes the folder at `http://<site>.fling.lvh.me:47102/30-10-26/`
and keeps the rest of the site; `pnpm cli versions <site>` shows the PATH it went to. `pnpm cli
pull <site> /tmp/<site>` downloads a site (the signed links point at `/dev-download` on the API, or
`/blob-download` on the Worker); change a file there and `pnpm cli deploy /tmp/<site>` publishes it
on the version pulled, while a second pulled copy deployed after it is refused with
`base_changed`. To try a real provider, set `OIDC_ISSUER`,
`OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` before `pnpm dev`, and allow the redirect URI
`http://fling.lvh.me:47100/auth/callback` on that client. For a Google client, set
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and allow
`http://fling.lvh.me:47100/auth/google/callback`; with both, the login page offers each.

**Live rooms locally.** Review mode's realtime runs on both runtimes. The Node dev server keeps
the rooms in process (`apps/api/src/live-memory.ts`) and accepts the sockets itself at
`ws://fling.lvh.me:47101/api/live` (its `LIVE_URL`, so the UI dev server needn't proxy sockets);
`wrangler dev` runs the `LiveRoom` Durable Objects locally at `ws://flingcf.lvh.me:47103/api/live`.
Open the same review page in two browser profiles to see each other's pointers.

**Forms locally.** Forms are on wherever comments are (the `forms` capability follows `COMMENTS`;
there is no config value of their own). To try them:

1. `pnpm cli forms init <folder> --template labels` writes a `fling.forms.json` (the other
   templates are `rubric`, `compare`, `issue` and `survey`); change its `paths` to match the
   folder's pages and run `pnpm cli forms check <folder>`.
2. `pnpm cli deploy <folder> --access members` deploys it and lists each form with the pages it
   applies to. `http://<name>.fling.lvh.me:47102/fling.forms.json` is a 404: the file is never a
   site file.
3. Open `http://fling.lvh.me:47100/review/<name>`: a page-kind form is the panel's tab named after
   the config's `title`, and a comment-kind one is a type in the new-comment box. Sign in as another
   `@example.test` address in a second browser profile to see an `own` form hide each reviewer's
   answers from the other, while the owner sees both.
4. `http://fling.lvh.me:47100/sites/<name>/responses` shows the page × reviewer grid, and
   `pnpm cli responses <name> --format csv` the export.

Where forms are stored:

- **The config** is a blob per version beside its manifest,
  `sites/<siteId>/_forms/<versionId>.json` (`formsKey`, `apps/api/src/blobs/types.ts`), outside
  every version's files, so the edge never serves it. Publication writes it when the deploy is made
  (`formsForDeploy`, `apps/api/src/forms.ts`): the request's `forms` when it sends them, none when
  it sends `null`, and otherwise the base's for a layered publish (a path publish, or a deploy of a
  pulled folder) and none for a whole-site deploy. A version is named by its files alone, so an
  `unchanged` or `repointed` deploy that sends `forms` rewrites that version's blob in place. The
  CLI sends the folder's file when there is one. Without it, a whole-site deploy sends `null`, and
  a layered one sends nothing (the site keeps its forms) unless the folder was pulled with a
  `fling.forms.json` that has since been deleted, which sends `null`.
- **Responses** are comment records, v2 (`CommentRecord`, `apps/api/src/store/types.ts`): `response`
  (`{ formId, data, versionId }`), `respondent` (the author's email, which `Store.updateResponse`
  conditions on) and `updatedAt` (when a page-kind response was last changed). A v1 comment needs
  nothing filled in (`evolution.ts`), so there is no migration. A page-kind response's id is
  `R<hash of form, path, author>` rather than a time-sortable one, so `listComments` sorts by
  `createdAt` in the core. `updateResponse` is in the conformance store suite.

**Notifications locally.** Mail is off until you turn it on:

- **Node** (`pnpm dev`): set `MAIL_DRIVER=file` and `MAIL_FROM=fling@mail.fling.lvh.me` first
  (`MAIL_DRIVER=file MAIL_FROM=fling@mail.fling.lvh.me pnpm dev`). Each message is written to
  `.fling-dev/mail/` (or `$FS_ROOT/mail/`) as an `.eml` and an `.html`. `MAIL_DRIVER=memory` keeps
  them in memory instead, as the e2e does.
- **`wrangler dev`**: `pnpm --filter @fling/platform-cloudflare dev --mail` (or `MAIL_DRIVER=cloudflare`
  and `MAIL_FROM=fling@mail.flingcf.lvh.me` in `platforms/cloudflare/.dev.vars`). The real
  `CloudflareMailer` sends through wrangler's simulated `send_email` binding, which logs each
  message and saves its parts to local files whose paths it prints.
- **Outside invitations** need mail: add `INVITES=on` (Node) or `--invites` (`wrangler dev`). An
  address outside `example.test` named in an audience or a group is then invited as a guest, and
  the share's email in `/dev/mail` carries their sign-in link.

To read what was sent, open `/dev/mail` on the app (<http://fling.lvh.me:47100/dev/mail> on Node, through the UI dev server:
the newest first, each message's HTML a click away; JSON with `Accept: application/json`), or the
files themselves. On Node it lists FileMailer's and MemoryMailer's messages; under `wrangler dev`,
a copy of each message the Worker sent since it started (KeptMailer, `apps/api/src/mail/kept.ts`). Each person's own list is on their
Settings → Notifications page and in `pnpm cli notifications sent`.

Nothing is sent the moment you act. `pnpm dev` drains the outbox every minute, as the platforms'
ticks do, about 75 seconds behind the clock, and a batch waits 2 minutes for more to fold in, so
an email takes up to about 4 minutes. `POST /dev/notify/drain` (dev login only) drains at once,
including everything due in the next hour (`flush`), and answers what it did:
`curl -X POST http://localhost:47101/dev/notify/drain` on Node (or `http://flingcf.lvh.me:47103/dev/notify/drain`).
`wrangler dev` runs no crons, so there the drain route is the only way mail goes out.

**The CLI against local.** Run `pnpm cli login http://fling.lvh.me:47100` (with the UI dev server running), then
`pnpm cli deploy <folder>`. The CLI remembers it beside any other Fling you are signed in to:
`pnpm cli use` lists them and `pnpm cli use <url>` switches back. To keep a throwaway login away
from your real config altogether, set `FLING_CONFIG_DIR=$(mktemp -d)`. `pnpm cli doctor` checks the
setup (CLI, config, each Fling, Claude Code, Claude Desktop) and changes nothing. A checkout older
than a Fling it talks to says a newer release is out; `FLING_NO_UPDATE_CHECK=1` quietens it.

**The e2e scenario.** Run `pnpm build && pnpm e2e` (or `pnpm --filter @fling/e2e e2e aws` for one
runtime). It starts each runtime on free ports with fresh state, runs
`packages/e2e/src/scenario.ts` through the real CLI and over HTTP, then stops it. Both runtimes run
with mail on (MemoryMailer on Node, the CloudflareMailer over the simulated binding under
`wrangler dev`), and the scenario drains with `POST /dev/notify/drain` and reads what each person
was sent from `GET /api/me/notifications/sent`.

## Adding a feature

A feature is written once in the core and must work on every platform:

1. **Domain and persistence.** Add records and keys in `apps/api/src/store/records.ts`. Keep keys
   site-centric, and add index items rather than scans. If stored data must change shape, bump the
   record's `v` and write a migration (see below).
2. **Access.** Add the actions to `apps/api/src/policy.ts` with cases in `tests/policy.test.ts`.
   Routes resolve sites through `requireSite`.
3. **API and MCP.** Add the routes in `apps/api/src/routes/` and the remote MCP tools in
   `apps/api/src/mcp/`. Shared request and response types go in `packages/shared`.
4. **Capability.** If an instance may switch the feature off, add a config switch and a flag in
   `/.well-known/fling` (`apps/api/src/instance.ts`). Clients check the flag, never the platform.
5. **Clients.** The web UI goes in `apps/web/src/pages`. The CLI commands and the local MCP tools go
   in `apps/cli`; update its README, and the plugin's `SKILL.md` if agents should use the feature.
6. **Platforms.** If the feature needs a new port operation, extend the conformance suite first,
   then every adapter: memory, DynamoDB/S3 and D1/R2/KV.
7. **Proof.** Add API tests, add a step to the e2e scenario, and run `pnpm gate`.
8. **Docs.** Update CONTEXT.md for new terms, the README for user-visible behaviour, and the AWS deploy
   guide's Instance configuration table for new configuration. Add a bullet under `## Unreleased`
   in the root [CHANGELOG.md](../CHANGELOG.md), with an upgrade note if it asks anything of users
   or operators.

## Adding a data migration

Add `apps/api/src/migrations/NNNN-<what>.ts` and append it to `MIGRATIONS` in `index.ts`.
Migrations are append-only: never edit one that has run. A migration is written against `Table`
with its own key and shape definitions, and is:
- idempotent;
- resumable, because the runner checkpoints each page;
- safe while the API is serving.

Use expand/contract. The release that ships a migration must work both before and after it runs.
Mark destructive steps `auto: false` and run them by hand later. Then:
- **Test it.** Add a test, and the conformance suite in `packages/conformance/src/migrations.ts`
  runs it on every Table adapter.
- **Rehearse it.** Before it first runs on a production table, rehearse it on a point-in-time copy
  ([platforms/aws/DEPLOY.md](../platforms/aws/DEPLOY.md#rehearsing-a-data-migration-point-in-time-copy)).

Deploys run pending migrations after the new code is live. AWS invokes the Lambda with
`{"fling":"migrate"}`. Cloudflare runs `scripts/migrate.ts` over a remote D1 binding.

## Adding a configuration value

1. Add it to the schema in `apps/api/src/config.ts`, with production checks.
2. Expose it in `instance.ts` only if clients need it. Never expose emails or secrets.
3. Document it in the Instance configuration table in `platforms/aws/DEPLOY.md`, which the
   Cloudflare guide links to.
4. Wire it through each platform's `INSTANCE` config: on AWS `instance.json`, on Cloudflare
   `scripts/setup.mjs` and `scripts/config.mjs`.

Secrets go to SSM on AWS and to Worker secrets on Cloudflare.

## Adding a platform

A platform is `platforms/<cloud>/` with:
- an entry point that builds `Deps` (`buildDeps` with its own adapters);
- adapters for `Table`, `Blobs` and `RouteTable` that pass `packages/conformance`;
- a `LiveHub` for the live rooms (`apps/api/src/live.ts`): something that keeps a site's sockets
  and runs the core's room functions (`joinRoom`, `receive`, `leaveRoom`, `broadcast`) over them,
  plus a `LIVE_URL` where clients connect. A hub whose connections outlive one process keeps them
  as live connection records through the `Store` (as AWS does). Without one, leave `LIVE_URL` unset
  and the `live` capability is off;
- a sites host that calls `routeSiteRequest` and adds the decision's `headers` to what it serves;
- infrastructure and deploy scripts, plus a `DEPLOY.md`;
- a local runtime added to `packages/e2e/src/local.ts`.

Differences between platforms are capability flags, never `if (platform === …)`.

## Shipping

- `main` is protected. Open a PR, wait for the **Gate** check, then rebase-merge
  (`gh pr merge --rebase`). Every PR that changes behaviour adds its bullet under `## Unreleased`
  in [CHANGELOG.md](../CHANGELOG.md).
- Merging deploys nothing. A release does: its tag publishes the CLI and deploys the AWS production
  instance (see [Releasing](#releasing)). That deploy covers the API, data migrations, the smoke
  check, the UI, the 404 page, the review shell, the sites' robots.txt and the site router.
- The Cloudflare instance is deployed by hand through the **Deploy (Cloudflare)** workflow with the
  release tag as `ref`, or locally with `pnpm --filter @fling/platform-cloudflare run deploy` from
  a checkout of the tag. It ends with the e2e smoke test.
- To roll back, run either deploy workflow with an older release tag. Data is never rolled back,
  which is why migrations use expand/contract.

## Releasing

A release is one version of all of Fling: the server on every platform, the web UI, the CLI and
its local MCP server, the Claude Desktop extension and the plugin. It is a commit on `main` whose
version files and CHANGELOG say `x.y.z`, tagged `vx.y.z`. The version is in the root
`package.json`, `apps/cli/package.json`, `apps/cli/mcpb/manifest.json` and
`plugin/.claude-plugin/plugin.json` (the list is `VERSION_FILES` in `scripts/release.mjs`); the
other workspace packages are private and keep their own. A server says which release it runs as
`release` in `/.well-known/fling`. The CLI and its local MCP server compare it with their own version and
say when a newer one is out (`apps/cli/src/update-check.ts`). Up to 0.6.0, releases were the CLI's alone (`cli-v*` tags).

1. On a branch, cut it:

   ```sh
   pnpm release 0.7.0            # --dry-run shows what it would write
   ```

   It refuses a version that isn't `x.y.z` or isn't greater than the current one, and an empty
   Unreleased section. It sets the version in every version file and moves the Unreleased bullets
   under `## 0.7.0 (<date>)`, leaving Unreleased empty.
2. Commit, open a PR, wait for the **Gate** check and merge it (`gh pr merge --rebase`).
3. Tag the release commit on `main` and push the tag:

   ```sh
   git fetch origin
   git tag -a v0.7.0 -m "Fling 0.7.0" <release commit> && git push origin v0.7.0
   ```

The tag starts the **Release** workflow (`.github/workflows/release-cli.yml`):

1. it checks that the tag matches every version file and that the commit is on `main`;
2. it runs the gate (`ci.yml`) on that commit;
3. it publishes the CLI to npm through trusted publishing (OIDC: no stored token, provenance added
   automatically);
4. it creates the GitHub Release `v0.7.0`, with the version's CHANGELOG section as its notes and
   the Claude Desktop extension (`fling.mcpb`) attached.

When the Release workflow succeeds, **Deploy** (`deploy.yml`) deploys that commit to the AWS
production instance; its smoke test checks that `/.well-known/fling` answers with the new
`release`. Deploy Cloudflare by hand from the same tag (**Deploy (Cloudflare)**, `ref` `v0.7.0`).

**Redeploy or roll back.** Run **Deploy** by hand from `main` (Actions → Deploy → Run workflow)
with a release tag as `ref`: the current tag redeploys, an older one rolls back. Do the same with
**Deploy (Cloudflare)**. A rollback ships older code onto newer data, so check the CHANGELOG's
upgrade notes for the releases in between.

**Choosing the version.** Fling follows semver for the product as a whole:

- **minor** (`0.7.0` → `0.8.0`) for features;
- **patch** (`0.7.0` → `0.7.1`) for fixes only;
- a change that breaks older CLIs, extensions or plugins against a newer server, or a data contract
  (stored records, the metadata, an API response clients rely on), is called out in the release's
  CHANGELOG entry with an upgrade note saying what to do. Before 1.0 it goes out in a minor
  release.
