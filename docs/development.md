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

**Signing in.** Local dev uses a dev login form: any `@example.test` address gets in, and
`admin@example.test` is an admin. To try a real provider, set `OIDC_ISSUER`, `OIDC_CLIENT_ID` and
`OIDC_CLIENT_SECRET` before `pnpm dev`, and allow the redirect URI
`http://fling.lvh.me:47100/auth/callback` on that client.

**The CLI against local.** Run `pnpm cli login http://fling.lvh.me:47100` (with the UI dev server running), then
`pnpm cli deploy <folder>`. To keep this config away from your real one, set
`FLING_CONFIG_DIR=$(mktemp -d)`.

**The e2e scenario.** Run `pnpm build && pnpm e2e` (or `pnpm --filter @fling/e2e e2e aws` for one
runtime). It starts each runtime on free ports with fresh state, runs
`packages/e2e/src/scenario.ts` through the real CLI and over HTTP, then stops it.

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
   in `apps/cli`; update its README and CHANGELOG under Unreleased, and the plugin's `SKILL.md` if
   agents should use the feature.
6. **Platforms.** If the feature needs a new port operation, extend the conformance suite first,
   then every adapter: memory, DynamoDB/S3 and D1/R2/KV.
7. **Proof.** Add API tests, add a step to the e2e scenario, and run `pnpm gate`.
8. **Docs.** Update CONTEXT.md for new terms, the README for user-visible behaviour, and the AWS deploy
   guide's Instance configuration table for new configuration.

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
- a sites host that calls `routeSiteRequest`;
- infrastructure and deploy scripts, plus a `DEPLOY.md`;
- a local runtime added to `packages/e2e/src/local.ts`.

Differences between platforms are capability flags, never `if (platform === …)`.

## Shipping

- `main` is protected. Open a PR, wait for the **Gate** check, then rebase-merge
  (`gh pr merge --rebase`).
- A merge to `main` deploys the AWS production instance (`deploy.yml` runs after CI passes). That
  deploy covers the API, data migrations, the smoke check, the UI, the 404 page and the site router.
- The Cloudflare instance is deployed by hand through the **Deploy (Cloudflare)** workflow, or
  locally with `pnpm --filter @fling/platform-cloudflare run deploy`. It ends with the e2e smoke
  test.
- To roll back, run either deploy workflow with an older `ref` from `main`. Data is never rolled
  back, which is why migrations use expand/contract.

### Releasing the CLI

Bump `apps/cli/package.json`, move the CHANGELOG's Unreleased entries under the new version, merge,
then tag that commit:

```sh
git tag -a cli-v0.3.0 -m "CLI 0.3.0" && git push origin cli-v0.3.0
```

`release-cli.yml` checks that the tag matches the version, runs the gate, and publishes to npm
through trusted publishing (OIDC: no stored token, provenance added automatically).
