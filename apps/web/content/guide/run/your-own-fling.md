---
title: Run your own Fling
part: run
order: 10
summary: What an instance is, on AWS, Cloudflare, Google Cloud, Azure, DigitalOcean or your own machines, and how its name, sign-in and brand are set.
sources: [platforms/aws/DEPLOY.md, platforms/cloudflare/DEPLOY.md, platforms/gcp/DEPLOY.md, platforms/azure/DEPLOY.md, platforms/digitalocean/DEPLOY.md, platforms/node/DEPLOY.md, apps/api/src/config.ts, apps/api/src/instance.ts]
verified: 79489687d
---

Fling is open source. Anyone can run their own, on their own cloud account or machines, under their own
domain, for the people they choose. {{instance:name}} is one such Fling. This page is an overview;
the deploy guides in the repository are the step-by-step manual.

## What an instance is

One running Fling is an **instance**. Each one has:

- **One cloud**: AWS, Cloudflare, Google Cloud, Azure or DigitalOcean, in an account you own, or
  machines you run yourself.
- **Its own name**, shown in the web app, the CLI and assistants.
- **Its own domains**: one for the web app, and one the sites hang off, so a site is
  `https://<name>.<sites domain>`.
- **Its own sign-in**: an OpenID Connect provider you already use (Google, Microsoft, Okta and
  others), and the email domains or addresses it admits.
- **Its own brand**: logo, favicon and colours.

Everything that makes an instance itself is configuration, none of it in the code. The same CLI,
assistant connector and web app work with every instance: they learn its name, addresses,
sign-in and features from the instance when you connect.

## Choosing a cloud

Each runs the same Fling. Pick the cloud you already use, or run it on your own machines; the
table says where they differ.

| | AWS | Cloudflare | Google Cloud | Azure | DigitalOcean | Your own machines |
|---|---|---|---|---|---|---|
| Runs on | Lambda, S3, DynamoDB and CloudFront | One Worker, with D1, R2 and Workers KV | One Cloud Run service behind a load balancer, with Firestore and Cloud Storage | Container Apps, Cosmos DB, Blob Storage and Front Door | One App Platform app, with Managed PostgreSQL and Spaces | One container image, with Postgres and an S3-compatible store |
| Set up with | A Terraform module you call from your own Terraform | A setup script, run once | A Terraform module you call from your own Terraform | A Terraform module you call from your own Terraform | A Terraform module you call from your own Terraform | A Docker Compose file on one machine, or a Helm chart on Kubernetes |
| Deployed by | A GitHub workflow, on each release | A deploy script, by hand or from a GitHub workflow | A GitHub workflow, by hand | A GitHub workflow, by hand | A GitHub workflow, by hand | You: build or pull each release's image and restart on it |
| Email, optional | Amazon SES | Cloudflare Email Service | A provider's SMTP server | Azure Communication Services | A provider's SMTP server | A provider's SMTP server |
| Site servers, optional | Lambda Web Functions | The Worker Loader, in beta | Not yet | Not yet | Not yet | Not yet |
| Live review rooms | Yes | Yes | On one service instance | Yes | Yes | Yes |
| Cost when idle | About nothing; you pay for use | The Workers Paid plan, plus a certificate add-on for some domain layouts | About $20–25 a month, mostly the load balancer | About $40–45 a month, mostly Front Door | A fixed monthly price for the smallest app, database, Spaces and registry | Your machines: one small machine runs the Compose file for a team |

The deploy guides list current costs for each.

## What you need

- **A cloud account** where you can create resources: AWS, Cloudflare on the Workers Paid plan,
  a Google Cloud project with billing, an Azure subscription or a DigitalOcean team. To run it
  yourself: a machine with Docker, or a Kubernetes cluster with a Postgres and an S3-compatible
  bucket.
- **A domain** whose DNS you control, for the web app and the sites. The sites' domain must sit
  under the same registrable domain as the app's (`example.com`, say).
- **A sign-in provider**: an OpenID Connect client you register, or a Google OAuth client.
- **The repository**: clone it, or fork it to deploy from your own copy.
- **For email (optional)**: a sending domain set up with Amazon SES, Cloudflare Email Service,
  Azure Communication Services or, on Google Cloud, DigitalOcean and your own machines, a provider
  that sends over SMTP.
  Notifications and outside invitations need it.

## How an instance is configured

You set the instance's values once, in its deploy config, and they take effect on the next
deploy. The main ones:

| What | Setting |
|---|---|
| Name | `INSTANCE_NAME` |
| Who may sign in | `ALLOWED_EMAIL_DOMAINS` (whole domains) and `ALLOWED_EMAILS` (single addresses); at least one |
| Admins | `ADMIN_EMAILS`, each an address that may sign in |
| Sign-in provider | `OIDC_ISSUER` and `OIDC_CLIENT_ID`, or a Google client |
| Brand | `BRAND_PRIMARY`, `BRAND_ACCENT`, `BRAND_LOGO_URL` and the other `BRAND_*` values |
| Who can open a new site | `SITE_DEFAULT_ACCESS`: its owner alone, or everyone signed in |
| Feature switches | `COMMENTS`, `LIVE` (on unless turned off), `INVITES` (off unless turned on; needs email) |
| Site servers | `SERVERS`: nobody (the default), admins, named groups or every member; `SERVERS_EGRESS` for whether they reach the internet, and the `SERVER_*` limits |
| Versions kept | `VERSION_RETENTION` (every version, unless set) |

The domains come from the infrastructure: Terraform's inputs on AWS, Google Cloud, Azure and
DigitalOcean, the setup script's on Cloudflare, and the Compose `.env` file or the Helm chart's
values on your own machines. Secrets, such as the sign-in client's, are kept apart from the config:
in the cloud's own secret store (encrypted app variables on DigitalOcean), or in the Compose `.env`
file or a Kubernetes Secret.

Once it runs, its admins can see every value it runs with at **Admin → Settings** in the web
app. Changing one is a deploy.

## The deploy guides

- [Deploying Fling on AWS]({{fact:repo-url}}/blob/main/platforms/aws/DEPLOY.md), with every
  setting in its
  [Instance configuration]({{fact:repo-url}}/blob/main/platforms/aws/DEPLOY.md#instance-configuration)
  table.
- [Deploying Fling on Cloudflare]({{fact:repo-url}}/blob/main/platforms/cloudflare/DEPLOY.md).
- [Deploying Fling on Google Cloud]({{fact:repo-url}}/blob/main/platforms/gcp/DEPLOY.md).
- [Deploying Fling on Azure]({{fact:repo-url}}/blob/main/platforms/azure/DEPLOY.md).
- [Deploying Fling on DigitalOcean]({{fact:repo-url}}/blob/main/platforms/digitalocean/DEPLOY.md).
- [Self-hosting Fling]({{fact:repo-url}}/blob/main/platforms/node/DEPLOY.md), with Docker
  Compose or Kubernetes.

Each opens with a prompt you can give your coding agent, which then follows the guide and asks you
for what it needs before it creates anything.

