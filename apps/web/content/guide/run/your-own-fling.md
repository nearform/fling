---
title: Run your own Fling
part: run
order: 10
summary: What an instance is, AWS or Cloudflare, and how its name, sign-in and brand are set.
sources: [platforms/aws/DEPLOY.md, platforms/cloudflare/DEPLOY.md, apps/api/src/config.ts, apps/api/src/instance.ts]
verified: 998e984
---

Fling is open source. Anyone can run their own, on their own cloud account, under their own
domain, for the people they choose. {{instance:name}} is one such Fling. This page is an overview;
the deploy guides in the repository are the step-by-step manual.

## What an instance is

One running Fling is an **instance**. Each one has:

- **One cloud**: AWS or Cloudflare, in an account you own.
- **Its own name**, shown in the web app, the CLI and assistants.
- **Its own domains**: one for the web app, and one the sites hang off, so a site is
  `https://<name>.<sites domain>`.
- **Its own sign-in**: an OpenID Connect provider you already use (Google, Microsoft, Okta and
  others), and the email domains or addresses it admits.
- **Its own brand**: logo, favicon and colours.

Everything that makes an instance itself is configuration, none of it in the code. The same CLI,
assistant connector and web app work with every instance: they learn its name, addresses,
sign-in and features from the instance when you connect.

## AWS or Cloudflare

Both run the same Fling with the same features. Pick the cloud you already use.

| | AWS | Cloudflare |
|---|---|---|
| Runs on | Lambda, S3, DynamoDB and CloudFront | One Worker, with D1, R2 and Workers KV |
| Set up with | A Terraform module you call from your own Terraform | A setup script, run once |
| Deployed by | A GitHub workflow, on each release | A deploy script, by hand or from a GitHub workflow |
| Email, optional | Amazon SES | Cloudflare Email Service |
| Cost when idle | About nothing; you pay for use | The Workers Paid plan, plus a certificate add-on for some domain layouts |

The deploy guides list current costs for each.

## What you need

- **A cloud account** where you can create resources: AWS, or Cloudflare on the Workers Paid plan.
- **A domain** whose DNS you control, for the web app and the sites. The sites' domain must sit
  under the same registrable domain as the app's (`example.com`, say).
- **A sign-in provider**: an OpenID Connect client you register, or a Google OAuth client.
- **The repository**: clone it, or fork it to deploy from your own copy.
- **For email (optional)**: a sending domain set up with Amazon SES or Cloudflare Email Service.
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
| Versions kept | `VERSION_RETENTION` (every version, unless set) |

The domains come from the infrastructure: Terraform's inputs on AWS, the setup script's on
Cloudflare. Secrets, such as the sign-in client's, are kept apart from the config, in the cloud's
own secret store.

Once it runs, its admins can see every value it runs with at **Admin → Settings** in the web
app. Changing one is a deploy.

## The deploy guides

- [Deploying Fling on AWS]({{fact:repo-url}}/blob/main/platforms/aws/DEPLOY.md), with every
  setting in its
  [Instance configuration]({{fact:repo-url}}/blob/main/platforms/aws/DEPLOY.md#instance-configuration)
  table.
- [Deploying Fling on Cloudflare]({{fact:repo-url}}/blob/main/platforms/cloudflare/DEPLOY.md).

Each opens with a prompt you can give your coding agent, which then follows the guide and asks you
for what it needs before it creates anything.

