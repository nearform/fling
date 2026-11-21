# Fling

**Throw it. Get a link.** Fling turns a folder, an HTML file or a zip, made by you or by any agent,
into `https://<name>.<your Fling>`: private to your team, live in seconds.

> **Fling runs in your own cloud.** It isn't a hosted service you sign up to: first someone deploys
> a Fling for your organisation, at an address like `fling.yourcompany.com`, on AWS, Cloudflare,
> DigitalOcean or machines you run. Then everyone installs the CLI or adds the connector and
> points it at that address.
> **[Deploy your Fling →](#deploy)** Already have one? Start below.

```sh
npm install -g @nearform/fling
fling setup https://<your Fling>     # sign in, add Fling to Claude Code and Claude Desktop
fling deploy ./dist --name demo      # → https://demo.<your Fling>/
```

**Why Fling?** Click through the deck, flung with Fling itself:
<https://why-fling.fling.labs.nearform.com/>

**See it working.** Five short walkthroughs, each starting with a problem and recorded on a real
Fling: <https://fling-tour.fling.labs.nearform.com/>

- **From anywhere.** The CLI, Claude Code (plugin), Claude Desktop (extension), Claude on the web
  and mobile (connector `https://<your Fling>/mcp`), and any script, CI job or background agent
  with an API key.
- **Private by default.** A new site is yours alone until you say who else may see it: specific
  people, teams, everyone signed in with your identity provider, or anyone. Share links, public sites, archive and delete are one command each. Secrets and dotfiles never ship.
- **Every deploy is a version.** Same link, new contents; roll back instantly.
- **Review it together, live.** Pin comments to the exact spot, see each other's pointers, and let
  agents read the feedback and act on it. Ship a form with the site to collect labels or scores,
  and export the answers as CSV. Watch the walkthroughs on [reviews](https://fling-tour.fling.labs.nearform.com/get-started/) and
  [forms](https://fling-tour.fling.labs.nearform.com/eval-labelling/).
- **A small server when a page isn't enough.** Put a `server.ts` beside `index.html` and Fling runs
  it for `/api/*`, behind the site's sign-in, with its keys kept as site secrets: call an API, post
  to Slack, keep a price list off the page. Off unless the instance turns it on. See
  [docs/site-servers.md](docs/site-servers.md), or [watch the walkthrough](https://fling-tour.fling.labs.nearform.com/site-server/).
- **Hear about it.** With email set up, people are told when a site is shared with them, they join a
  group, or someone comments on their site, and choose what they hear about from any client.
- **Yours.** Run it on AWS, Cloudflare, DigitalOcean or your own machines, under your domain,
  sign-in and brand.

## Use it

- **CLI**: `npm install -g @nearform/fling` (or `npx @nearform/fling`), then
  `fling setup <your Fling's address>` and `fling deploy ./dist`. Signed in to several Flings,
  `fling use` switches between them. See [apps/cli](apps/cli/README.md).
- **Claude (Desktop, web, mobile)**: add the connector `https://<your Fling>/mcp` under
  Settings → Connectors, or install the Claude Desktop extension from the Get started page.
  [Watch the walkthrough](https://fling-tour.fling.labs.nearform.com/claude-app/).
- **Claude Code**: `fling setup`, or `/plugin marketplace add nearform/fling`, then
  `/plugin install fling@fling`. [Watch the walkthrough](https://fling-tour.fling.labs.nearform.com/get-started/).

## How it works

Each of these has the full detail in [docs/how-it-works.md](docs/how-it-works.md).

**Your instance.** Each organisation runs its own Fling, with its own domain, sign-in (any OpenID
Connect provider) and look. Clients discover it from `/.well-known/fling`, so one CLI works with
several. [More](docs/how-it-works.md#instances)

**Who can open a site**
- **[Access levels](docs/how-it-works.md#access-levels):** only you, groups, specific people, everyone signed in, or
  public. New sites are private, and a redeploy never changes access.
- **[Audiences and groups](docs/how-it-works.md#audiences):** limit a site to named people and groups; removing
  someone takes effect within 5 minutes.
- **[Owners and publishers](docs/how-it-works.md#owners-and-publishers):** share a site so it outlives whoever
  created it; publishers can only publish and roll back.
- **[Invitations](docs/how-it-works.md#invitations):** optionally let in reviewers from outside your email domains.

**Publishing**
- **[Paths](docs/how-it-works.md#paths-one-site-a-folder-per-ticket):** one site, a folder per ticket, each with
  its own versions, rollback and owners. [Walkthrough](https://fling-tour.fling.labs.nearform.com/team-site/).
- **[Pull](docs/how-it-works.md#pull):** download a live site, change it, and publish only what changed, without
  overwriting someone else's publish.
- **[Markdown](docs/how-it-works.md#markdown)** files are served as pages.
- **[Retention](docs/how-it-works.md#retention):** keep every version (the default) or only the newest.

**Reviewing**
- **[Review](docs/how-it-works.md#review):** comments pinned to a spot or a passage, beside the live site.
  [Walkthrough](https://fling-tour.fling.labs.nearform.com/get-started/).
- **[Live review](docs/how-it-works.md#live-review):** comments and pointers appear for everyone as they happen.
- **[Forms](docs/how-it-works.md#structured-feedback-forms):** collect labels, ratings or any structured answer
  per page, blind if you like, and export them as CSV or JSON. [Walkthrough](https://fling-tour.fling.labs.nearform.com/eval-labelling/).
- **[Notifications](docs/how-it-works.md#notifications):** email when a site is shared with you or someone
  comments, each person choosing what they hear about.
- **[Previews and thumbnails](docs/how-it-works.md#previews-and-thumbnails)** of each site in the web UI.

## Layout

| Path | What |
|---|---|
| `apps/api` | The cloud-agnostic Hono API: sign-in, CLI keys, deploys, the instance metadata, the remote MCP server and its OAuth server |
| `platforms/aws` | The API on AWS: Lambda entry point and the DynamoDB, S3, CloudFront KeyValueStore and SSM adapters; builds `lambda.zip`. Its Terraform module is `platforms/aws/infra` |
| `platforms/cloudflare` | Fling on Cloudflare: one Worker (API, UI from Static Assets, sites) with the D1, R2 and Workers KV adapters; `wrangler.jsonc`, setup and deploy scripts |
| `platforms/gcp` | Fling on Google Cloud: the Node host on Cloud Run with the Firestore Table, the Cloud Storage Blobs and Cloud Scheduler's OIDC tick check; its Dockerfile, and its Terraform module `platforms/gcp/infra` |
| `platforms/azure` | Fling on Azure: the Node host on Container Apps behind Front Door, with the Cosmos DB, Blob Storage, Web PubSub and Communication Services Email adapters; the container image and its Terraform module `platforms/azure/infra` |
| `platforms/node` | The building blocks for platforms on Node: the Node host (one HTTP server for the API, UI, sites and live rooms), the Postgres Table, the Postgres live fan-out and the SMTP mailer; runnable on its own (`src/main.ts`). Its image (`Dockerfile`), Docker Compose file and Helm chart (`deploy/`) are the self-host platform |
| `platforms/s3` | S3-compatible object storage (`S3Blobs`), shared by AWS and the Node host: S3, Spaces, MinIO or any store that speaks the S3 API |
| `platforms/digitalocean` | Fling on DigitalOcean: the Node host image on App Platform, Managed PostgreSQL and Spaces. Its Terraform module is `platforms/digitalocean/infra` |
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
and how to add a feature, a data migration, a config value or a platform, and how to release.
Terms are defined in [CONTEXT.md](CONTEXT.md), and what each release changed in
[CHANGELOG.md](CHANGELOG.md).

## Deploy

To run your own Fling, pick a platform below and follow its guide. You need a domain you control
(the app at e.g. `fling.yourcompany.com`, sites at `*.fling.yourcompany.com`) and an OpenID Connect
sign-in such as Google, Microsoft Entra ID or Okta. Each cloud is a platform under `platforms/`,
with its own entry point, adapters, infrastructure and deploy guide. Pick one per instance:

| Platform | Guide | Infrastructure |
|---|---|---|
| AWS (Lambda, S3, DynamoDB, CloudFront) | [platforms/aws/DEPLOY.md](platforms/aws/DEPLOY.md) | Terraform module [platforms/aws/infra](platforms/aws/infra) |
| Cloudflare (Workers, D1, R2, Workers KV) | [platforms/cloudflare/DEPLOY.md](platforms/cloudflare/DEPLOY.md) | `wrangler.jsonc` and [scripts/setup.mjs](platforms/cloudflare/scripts/setup.mjs) |
| Google Cloud (Cloud Run, Firestore, Cloud Storage, a load balancer) | [platforms/gcp/DEPLOY.md](platforms/gcp/DEPLOY.md) | Terraform module [platforms/gcp/infra](platforms/gcp/infra) |
| Azure (Container Apps, Cosmos DB, Blob Storage, Front Door) | [platforms/azure/DEPLOY.md](platforms/azure/DEPLOY.md) | Terraform module [platforms/azure/infra](platforms/azure/infra) |
| DigitalOcean (App Platform, Managed PostgreSQL, Spaces) | [platforms/digitalocean/DEPLOY.md](platforms/digitalocean/DEPLOY.md) | Terraform module [platforms/digitalocean/infra](platforms/digitalocean/infra) |
| Self-host (the Node host image, Postgres, an S3-compatible store) | [platforms/node/DEPLOY.md](platforms/node/DEPLOY.md) | Docker Compose ([deploy/compose](platforms/node/deploy/compose)) or a Helm chart ([deploy/helm/fling](platforms/node/deploy/helm/fling)) |

Every platform meets the same contract, the [logical platform](docs/design/platform.md), and has
a platform doc that maps it onto its cloud: [AWS](docs/platforms/aws.md),
[Cloudflare](docs/platforms/cloudflare.md), [Google Cloud](docs/platforms/gcp.md),
[Azure](docs/platforms/azure.md),
[DigitalOcean and self-host](docs/platforms/digitalocean-self-host.md). More clouds are planned,
each with its doc: [Fly.io](docs/platforms/fly.md) and [Vercel](docs/platforms/vercel.md). They build on
[`platforms/node`](platforms/node), which runs a whole Fling in one Node server on Postgres. See
[docs/platforms/](docs/platforms/README.md) for the comparison.

[![banner](https://raw.githubusercontent.com/nearform/.github/refs/heads/master/assets/os-banner-green.svg)](https://www.nearform.com/contact/?utm_source=open-source&utm_medium=banner&utm_campaign=os-project-pages)
