# Fling

Throw a folder of static files at a Fling server and get `https://<name>.<sites domain>` back.
One codebase, many instances: each instance runs on one cloud (AWS or Cloudflare) with its own
name, domains, sign-in and brand, published at `/.well-known/fling`.

- Domain terms: [CONTEXT.md](CONTEXT.md). Use its words (site, version, publication, policy,
  capability, platform…) in code, comments and docs.
- How to develop (setup, local runtimes, adding a feature, a migration, a config value, a platform,
  releasing): [docs/development.md](docs/development.md).
- Deploying an instance: [platforms/aws/DEPLOY.md](platforms/aws/DEPLOY.md),
  [platforms/cloudflare/DEPLOY.md](platforms/cloudflare/DEPLOY.md).
- Rules for agents: [.claude/rules/](.claude/rules/). Some always load; the rest load when you touch
  the paths they name.

## Layout

| Path | What |
|---|---|
| `apps/api` | The core: Hono API, policy, Records, migrations, MCP and OAuth. No cloud SDKs |
| `platforms/aws` | Lambda entry point, DynamoDB/S3/CloudFront KVS/SSM adapters, Terraform module (`infra/`) |
| `platforms/cloudflare` | One Worker (API, UI, sites), D1/R2/KV adapters, wrangler config, setup and deploy scripts |
| `packages/shared` | Contracts used by every app, including the sites' routing decision (`site-routing.ts`) |
| `packages/conformance` | Suites every adapter must pass (Table, Blobs, RouteTable, Store, migrations) |
| `packages/e2e` | The one scenario every platform passes, locally (`pnpm e2e`) and as the post-deploy smoke test |
| `edge` | The CloudFront Function, generated around `site-routing.ts` |
| `apps/web` | React UI and the sites' 404 page, themed from the instance metadata |
| `apps/cli` | The CLI, the local MCP server and the Claude Desktop extension (`.mcpb`) |
| `plugin` | The Claude Code plugin (skill and MCP config) |

## Commands

```sh
pnpm install
pnpm dev                                        # API :47101, sites :47102 (http://<name>.fling.lvh.me:47102)
pnpm --filter @fling/web dev                    # UI :47100, open http://fling.lvh.me:47100
pnpm --filter @fling/platform-cloudflare dev    # the Worker under wrangler dev :47103 (build web first)
pnpm --filter <package> test                    # one package's vitest
pnpm gate                                       # lint, terraform, typecheck, test, build, e2e: what CI runs
```

Run `pnpm gate` before every commit. CI runs exactly that command and adds only DynamoDB Local and
MinIO. Those suites skip locally unless you start the services (`platforms/aws/tests/services.ts`).

## Shipping

- `main` is protected. Branch, open a PR, wait for the **Gate** check, then
  `gh pr merge --rebase` (rebase, not squash: commits are kept). Afterwards, rebase local `main` onto
  `origin/main`.
- **Merging to `main` deploys the AWS production instance** (`deploy.yml` runs after CI). Merge only
  when the user says so.
- Cloudflare deploys and CLI releases are run by hand: `deploy-cloudflare.yml`, and a `cli-v*` tag
  for `release-cli.yml`.
- Anything live (deploys, terraform apply, data migrations on a real table, cloud console or CLI
  changes, GitHub variables or secrets) needs the user's go-ahead each time.
- Never print, commit or paste secrets. Pass them by file or environment variable.
