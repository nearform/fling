# Fling

Throw a folder of static files at a Fling server and get a link back:
`https://<name>.<sites domain>`. Sites are private to people signed in to that Fling by default;
share links open them to anyone with the link. Each deployment (an *instance*) has its own name,
domains, sign-in and look, which it publishes at `/.well-known/fling`; the CLI, the MCP servers and
the web UI read it from there, so none of them is tied to one instance.

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
| `platforms/aws` | The API on AWS: Lambda entry point and the DynamoDB, S3, CloudFront KeyValueStore and SSM adapters; builds `lambda.zip` |
| `apps/web` | React UI (sites, connections, get started) and the 404 page, themed at runtime from the instance metadata |
| `apps/cli` | `@nearform/fling` CLI, local MCP server and the `.mcpb` Claude Desktop extension |
| `edge` | CloudFront Function that routes `*.<sites domain>` to the right site version |
| `packages/shared` | Contracts shared by all of the above |
| `packages/conformance` | Test suites every storage adapter must pass (the core's memory/fs adapters; DynamoDB Local and MinIO in CI) |
| `plugin` | Claude Code plugin (skill + MCP) |

## Develop

```sh
pnpm install
pnpm dev          # API :47101, sites :47102 at http://<name>.fling.lvh.me:47102
pnpm --filter @fling/web dev   # UI :47100 → open http://fling.lvh.me:47100
pnpm gate         # lint, typecheck, test, build
```

Deployment: [docs/DEPLOY.md](docs/DEPLOY.md).
