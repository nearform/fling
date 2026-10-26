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
- Area rules: [.claude/rules/](.claude/rules/), each loaded when you touch the paths it names
  (persistence and migrations, access and auth, config and branding, site routing, testing).

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

## Architecture rules

Fling runs on several clouds and is not tied to any one instance. Every change keeps it that way.

- **The core is cloud-agnostic.** `apps/api` and `packages/shared` never import a cloud SDK; Biome
  enforces this. Cloud code lives in `platforms/<cloud>/`, behind the core's ports: `Table`,
  `Blobs`, `RouteTable` and `IdentityProvider`. A new storage need extends a port and every
  adapter, and the conformance suite proves they agree.
- **Write once.** Domain logic, Records, migrations, policy and the sites' routing decision exist
  once. Platforms only adapt. If you are writing the same logic in two platforms, move it into the
  core.
- **Capabilities, never platform checks.** When instances differ, the core advertises a flag in
  `/.well-known/fling` (`capabilities`, `apps/api/src/instance.ts`). Clients read the flag; nothing
  checks which cloud it is on.
- **The edge only rewrites.** The CloudFront Function and the Worker's sites host map
  `routeSiteRequest` (`packages/shared/src/site-routing.ts`) onto their runtime.
- **Authorization goes through `policy.ts`** (`can`, `canInstance`). Nothing else decides access.
- **Instance-agnostic artifacts.** The CLI, plugin, MCP servers and web UI learn everything about an
  instance from `/.well-known/fling`. No instance's domain, email, logo or colour appears in the
  code.
- **Every platform passes everything.** A feature is done when the conformance suites pass on every
  adapter and the e2e scenario (`packages/e2e/src/scenario.ts`) covers it on both local runtimes.

## Writing code, comments and docs

- **Describe what is, not what was.** Comments, docs and test names state the current behaviour and
  why. No "previously", "used to", "no longer", "the old X", phase numbers or who asked for it:
  history belongs in git and PR descriptions. Exceptions: migration headers (the data they
  rewrite) and upgrade notes in `apps/cli/CHANGELOG.md`.
- Match the surrounding code. File headers explain the module's job and constraints; inline
  comments explain why, never what.
- Use CONTEXT.md's terms. When you add a concept, add it there: a bold term, a short definition and
  the file that owns it.
- Prose is British English (behaviour, colour), plain and direct. Formatting is Biome's
  (`pnpm lint:fix`).
- When behaviour changes, update its docs in the same change: README, CONTEXT.md,
  `docs/development.md`, the deploy guides, `apps/cli/README.md`, the plugin's `SKILL.md`.

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
