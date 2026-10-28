# Fling

**Throw it. Get a link.** Fling turns a folder, an HTML file or a zip, made by you or by any agent,
into `https://<name>.<your Fling>`: private to your team, live in seconds.

```sh
npm install -g @nearform/fling
fling setup https://<your Fling>     # sign in, add Fling to Claude Code and Claude Desktop
fling deploy ./dist --name demo      # → https://demo.<your Fling>/
```

**Why Fling?** Click through the deck, flung with Fling itself:
<https://why-fling.fling.labs.nearform.com/>

- **From anywhere.** The CLI, Claude Code (plugin), Claude Desktop (extension), Claude on the web
  and mobile (connector `https://<your Fling>/mcp`), and any script, CI job or background agent
  with an API key.
- **Private by default.** Visitors sign in with your identity provider, and a site can be limited
  to the people you name. Share links, public sites, archive and delete are one command each. Secrets and dotfiles never ship.
- **Every deploy is a version.** Same link, new contents; roll back instantly.
- **Review it together, live.** Pin comments to the exact spot, see each other's pointers, and let
  agents read the feedback and act on it.
- **Yours.** Run it on AWS or Cloudflare, under your domain, sign-in and brand.

## Use it

- **CLI**: `npm install -g @nearform/fling` (or `npx @nearform/fling`), then
  `fling setup <your Fling's address>` and `fling deploy ./dist`. Signed in to several Flings,
  `fling use` switches between them. See [apps/cli](apps/cli/README.md).
- **Claude (Desktop, web, mobile)**: add the connector `https://<your Fling>/mcp` under
  Settings → Connectors, or install the Claude Desktop extension from the Get started page.
- **Claude Code**: `fling setup`, or `/plugin marketplace add nearform/fling`, then
  `/plugin install fling@fling`.

## How it works

**Instances.** Each deployment of Fling (an *instance*) has its own name, domains, sign-in and look,
which it publishes at `/.well-known/fling`. The CLI, the MCP servers and the web UI read it from
there, so none of them is tied to one instance. People sign in through the instance's OpenID
Connect provider (Google, Microsoft Entra ID, Okta, Auth0, …), limited to its email domains. Sites
are private to them by default; share links open a site to anyone with the link. No site is
indexed: every sites host answers `/robots.txt` with Fling's own `Disallow: /`, whatever the site
ships.

**Audiences.** The owner can limit a private site to listed people and groups (`fling access <site>
--add a@example.test --group design`, `fling_set_audience`, or the site's Access section in the web
UI). Each address must be one that can sign in; the owner always sees the site, and share links
still open it. A **group** is a named list of people (`fling groups`, `fling_groups`, the Groups page
in the web UI): anyone signed in can see one and use it, and only its owner can change it. The edge
holds no access lists: the API checks the audience when someone signs in to the site and hands them
a 5-minute site pass for that one host, renewed without a prompt. So removing someone (from the
audience or from a group in it) takes effect within 5 minutes. **Shared with me** lists the
restricted sites other people have limited to you, or to a group you are in (`fling ls --shared`,
`fling_list { shared: true }`, the Sites page's Shared with me tab).

**Review.** Anyone signed in can review a site they can open: `<app>/review/<name>` shows the site
in a frame beside its comments, threads per page that can be replied to, resolved and deleted.
- The frame follows the site's own navigation (single-page apps included) and stays on the site:
  a link elsewhere is stopped, with an offer to open it in a new tab.
- A pin is a spot you click, a box you drag, or text you select in the page (the thread quotes
  it, so agents see exactly what a comment is about); selecting its thread shows the box or text. Pins stick to the element they point at,
  whatever the reviewer's scroll or screen size; clicking one opens its thread and the other way
  round.
- Deploying and publishing give the review link first, as the one to share for feedback.
- The CLI (`fling comments`, `fling comment`), the MCP tools (`fling_comments_list`, …) and the web
  all use the same API.
- An instance turns comments off with `COMMENTS=false`; its metadata then lacks the `comments`
  capability and every client hides them.

**Live review.** Everyone with a site's review page open is in that site's room. New comments,
replies and resolutions appear without a refresh, each reviewer's pointer moves on the others'
screens with their name, and a row of avatars (profile picture or initials) shows who is there,
dimmed when they are on another page. The room is one WebSocket protocol on every platform: a
Durable Object on Cloudflare, an API Gateway WebSocket API on AWS. An instance without it
(`LIVE=false`, or no `LIVE_URL`) lacks the `live` capability, and review works as before,
refreshing comments every 30 seconds.

## Layout

| Path | What |
|---|---|
| `apps/api` | The cloud-agnostic Hono API: sign-in, CLI keys, deploys, the instance metadata, the remote MCP server and its OAuth server |
| `platforms/aws` | The API on AWS: Lambda entry point and the DynamoDB, S3, CloudFront KeyValueStore and SSM adapters; builds `lambda.zip`. Its Terraform module is `platforms/aws/infra` |
| `platforms/cloudflare` | Fling on Cloudflare: one Worker (API, UI from Static Assets, sites) with the D1, R2 and Workers KV adapters; `wrangler.jsonc`, setup and deploy scripts |
| `apps/web` | React UI (the site list, each site's page, connections, get started) and the 404 page, themed at runtime from the instance metadata |
| `apps/cli` | `@nearform/fling` CLI, local MCP server and the `.mcpb` Claude Desktop extension |
| `edge` | The CloudFront Function that routes `*.<sites domain>`: a generated shell around the shared routing decision |
| `packages/shared` | Contracts shared by all of the above, including the sites' routing decision (`site-routing.ts`) every platform's edge runs |
| `packages/conformance` | Test suites every storage adapter must pass (the core's memory/fs adapters; DynamoDB Local and MinIO in CI; Miniflare's D1, R2 and KV) |
| `why` | The "Why Fling?" deck: one static page, published with Fling itself (`fling deploy why --name why-fling`) |
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
