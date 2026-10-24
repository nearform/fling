# Fling

Throw a folder of static files at [fling.labs.nearform.com](https://fling.labs.nearform.com) and get a
link back: `https://<name>.fling.labs.nearform.com`. Sites are private to signed-in Nearformers by
default; share links open them to anyone with the link.

- **CLI**: `npm install -g @nearform/fling`, then `fling setup` (sign in, plus the Claude Code
  plugin and Claude Desktop extension) and `fling deploy ./dist`. Or run it without installing via
  `npx @nearform/fling`. See [apps/cli](apps/cli/README.md).
- **Claude (Desktop, web, mobile)**: add the connector `https://fling.labs.nearform.com/mcp` under
  Settings → Connectors, or install the Claude Desktop extension from the Get started page.
- **Claude Code**: `fling setup`, or `/plugin marketplace add nearform/fling`, then
  `/plugin install fling@fling`.

## Layout

| Path | What |
|---|---|
| `apps/api` | The cloud-agnostic Hono API: Google sign-in, CLI keys, deploys, the remote MCP server and its OAuth server |
| `platforms/aws` | The API on AWS: Lambda entry point and the DynamoDB, S3, CloudFront KeyValueStore and SSM adapters; builds `lambda.zip` |
| `apps/web` | React UI (sites, connections, get started) and the 404 page |
| `apps/cli` | `@nearform/fling` CLI, local MCP server and the `.mcpb` Claude Desktop extension |
| `edge` | CloudFront Function that routes `*.fling.labs.nearform.com` to the right site version |
| `packages/shared` | Contracts shared by all of the above |
| `plugin` | Claude Code plugin (skill + MCP) |

## Develop

```sh
pnpm install
pnpm dev          # API :3001, sites :3002 at http://<name>.fling.lvh.me:3002
pnpm --filter @fling/web dev   # UI :3000 → open http://fling.lvh.me:3000
pnpm gate         # lint, typecheck, test, build
```

Deployment: [docs/DEPLOY.md](docs/DEPLOY.md).
