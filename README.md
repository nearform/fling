# Fling

Throw a folder of static files at a Fling server and get a link back:
`https://<name>.<sites domain>`. Sites are private to people signed in to that Fling by default;
share links open them to anyone with the link. Each deployment (an *instance*) has its own name,
domains, sign-in and look, which it publishes at `/.well-known/fling`; the CLI, the MCP servers and
the web UI read it from there, so none of them is tied to one instance. People sign in through the
instance's OpenID Connect provider (Google, Microsoft Entra ID, Okta, Auth0, …), limited to its
email domains.

Anyone signed in can **review** a site they can open: `<app>/review/<name>` shows the site in a
frame beside its comments, threads per page that can be replied to, resolved and deleted. The
frame follows the site's own navigation (single-page apps included) and stays on the site: a link
elsewhere is stopped, with an offer to open it in a new tab. Pins stick to the element they point at, whatever the reviewer's
scroll or screen size; clicking one opens its thread and the other way round. Deploying and
publishing give the review link first, as the one to share for feedback. The
CLI (`fling comments`, `fling comment`), the MCP tools (`fling_comments_list`, …) and the web all
use the same API. An instance turns comments off with `COMMENTS=false`; its metadata then lacks
the `comments` capability and every client hides them.

- **CLI**: `npm install -g @nearform/fling`, then `fling setup <your Fling's address>` (sign in, plus
  the Claude Code plugin and Claude Desktop extension) and `fling deploy ./dist`. Or run it without
  installing via `npx @nearform/fling`. See [apps/cli](apps/cli/README.md).
- **Claude (Desktop, web, mobile)**: add the connector `https://<your Fling>/mcp` under
  Settings → Connectors, or install the Claude Desktop extension from the Get started page.
- **Claude Code**: `fling setup`, or `/plugin marketplace add nearform/fling`, then
  `/plugin install fling@fling`.

## Layout

| Path | What |
|---|---|
| `apps/api` | The cloud-agnostic Hono API: sign-in, CLI keys, deploys, the instance metadata, the remote MCP server and its OAuth server |
| `platforms/aws` | The API on AWS: Lambda entry point and the DynamoDB, S3, CloudFront KeyValueStore and SSM adapters; builds `lambda.zip`. Its Terraform module is `platforms/aws/infra` |
| `platforms/cloudflare` | Fling on Cloudflare: one Worker (API, UI from Static Assets, sites) with the D1, R2 and Workers KV adapters; `wrangler.jsonc`, setup and deploy scripts |
| `apps/web` | React UI (sites, connections, get started) and the 404 page, themed at runtime from the instance metadata |
| `apps/cli` | `@nearform/fling` CLI, local MCP server and the `.mcpb` Claude Desktop extension |
| `edge` | The CloudFront Function that routes `*.<sites domain>`: a generated shell around the shared routing decision |
| `packages/shared` | Contracts shared by all of the above, including the sites' routing decision (`site-routing.ts`) every platform's edge runs |
| `packages/conformance` | Test suites every storage adapter must pass (the core's memory/fs adapters; DynamoDB Local and MinIO in CI; Miniflare's D1, R2 and KV) |
| `packages/e2e` | The end-to-end scenario every platform must pass, on its local runtime (`pnpm e2e`) and as the post-deploy smoke test |
| `plugin` | Claude Code plugin (skill + MCP) |

## Develop

```sh
pnpm install
pnpm dev                       # API :47101, sites :47102 at http://<name>.fling.lvh.me:47102
pnpm --filter @fling/web dev   # UI :47100, open http://fling.lvh.me:47100 (dev login: any @example.test)
pnpm gate                      # lint, terraform, typecheck, test, build, e2e: what CI runs
```

See [docs/development.md](docs/development.md) for the Cloudflare local runtime, the e2e scenario,
and how to add a feature, a data migration, a config value or a platform. Terms are defined in
[CONTEXT.md](CONTEXT.md).

## Deploy

Each cloud is a platform under `platforms/`, with its own entry point, adapters, infrastructure and
deploy guide. Pick one per instance:

| Platform | Guide | Infrastructure |
|---|---|---|
| AWS (Lambda, S3, DynamoDB, CloudFront) | [platforms/aws/DEPLOY.md](platforms/aws/DEPLOY.md) | Terraform module [platforms/aws/infra](platforms/aws/infra) |
| Cloudflare (Workers, D1, R2, Workers KV) | [platforms/cloudflare/DEPLOY.md](platforms/cloudflare/DEPLOY.md) | `wrangler.jsonc` and [scripts/setup.mjs](platforms/cloudflare/scripts/setup.mjs) |
