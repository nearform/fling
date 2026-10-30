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
- **Private by default.** A new site is yours alone until you say who else may see it: specific
  people, teams, everyone signed in with your identity provider, or anyone. Share links, public sites, archive and delete are one command each. Secrets and dotfiles never ship.
- **Every deploy is a version.** Same link, new contents; roll back instantly.
- **Review it together, live.** Pin comments to the exact spot, see each other's pointers, and let
  agents read the feedback and act on it.
- **Hear about it.** With email set up, people are told when a site is shared with them, they join a
  group, or someone comments on their site, and choose what they hear about from any client.
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
Connect provider (Google, Microsoft Entra ID, Okta, Auth0, …), limited to its email domains. A new
site is visible only to its owner unless they choose otherwise (an instance can open new sites to
everyone signed in instead, `SITE_DEFAULT_ACCESS`); share links open a site to anyone with the
link. No site is
indexed: every sites host answers `/robots.txt` with Fling's own `Disallow: /`, whatever the site
ships.

**Access levels.** Who can open a site is one of five levels: only you, teams (groups), specific
people, everyone signed in, or public. Choose it on the first deploy (`fling deploy --access
only_me|members|groups|people|public`, `access` on `fling_deploy` and `fling_publish`; the MCP
servers ask the user first) and change it later (`fling access <site> --only-me | --members |
--public`, `fling_set_access`, or the site's Access section in the web UI). A re-deploy never
changes it.

**Audiences.** The owner can limit a site to listed people and groups (`fling access <site>
--add a@example.test --group design`, `fling_set_audience`, or the site's Access section in the web
UI). Each address must be one that can sign in, or, where the instance invites people from outside,
one it invites as a reviewer (see Invitations); the owner always sees the site, and share links
still open it. A **group** is a named list of people (`fling groups`, `fling_groups`, the Groups page
in the web UI): anyone signed in can see one and use it, and only its owner can change it. The edge
holds no access lists: the API checks the audience when someone signs in to the site and hands them
a 5-minute site pass for that one host, renewed without a prompt. So removing someone (from the
audience or from a group in it) takes effect within 5 minutes. **Shared with me** lists the
restricted sites other people have limited to you, or to a group you are in (`fling ls --shared`,
`fling_list { shared: true }`, the Sites page's Shared with me tab).

**Owners and publishers.** A site's owners are equal: each publishes, rolls back, changes its
access and settings, its owners and publishers, and archives or deletes it. Its publishers publish
and roll back, and change nothing else. Both are people or groups (`fling owners <site> --add
a@example.test --group design`, `fling publishers <site> …`, `fling_set_owners`,
`fling_set_publishers`, or the site's Owners and publishers section in the web UI), members of the
instance only, never guests. A site always keeps at least one person as an owner, so it carries on
when whoever created it is away or leaves. Naming a group trusts whoever manages it. People given a
role are told by email, where the instance sends it.

**Path publish.** A deploy can replace just one folder of a site and keep the rest: `fling deploy
./report --name changelog --path 30-10-26` serves the report at `<changelog>/30-10-26/` while every
other page stays as it was (`path` on the MCP tools). One report a week under a shared changelog
site, each by whichever owner or publisher wrote it, is the use it is for. If someone else publishes
the site meanwhile, the deploy runs again on top of theirs; rolling back removes the folder. The
rest of the site is copied into the new version, up to 1,000 files.

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

**Notifications.** With email set up, people hear when a site is shared with them (directly or
through a group), when they are added to a group, and when someone comments on their site or
replies in their thread; never about their own actions. Comments that arrive close together fold
into one email. Each person chooses what they hear about from every client (Settings →
Notifications, `fling notifications`, `fling_notifications_set`), and every email has a one-click
unsubscribe. Email goes out through each cloud's own service (SES on AWS, Email Service on
Cloudflare) from a sender the operator already has; admins check the setup at `/admin/mail` with a
test email, and see the whole configuration (secrets by name only) at `/admin/settings`. An
instance without a mail sender lacks the `email` and `notifications` capabilities, and every client
hides the settings. See each platform's deploy guide, Email.

**Invitations.** An instance with mail can let in people from outside its email domains
(`INVITES=on`; off by default). Sharing a site, or adding someone to a group, with an outside
address invites them as a **guest**: a reviewer who sees and comments on what is shared with them
and on public sites, and nothing else (no sites, groups, API keys or app connections of their own).
Their first email is the share's notification, with a sign-in link; guests sign in with emailed
single-use links, never at the instance's identity provider. Each person invites at most
`INVITES_PER_DAY` new outside addresses a day. Admins invite full members from Admin → Invitations
and revoke any invitation there, which cuts that person off on their next request, at the sites'
edge too (within about a minute on Cloudflare). A guest no
audience or group names any more is cut off too, until someone shares with them again. See each
platform's deploy guide, Outside invitations.

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
| `why` | The "Why Fling?" deck: one static page, published with Fling itself (`fling deploy why --name why-fling --access public`); Get started links to it once it is live |
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
