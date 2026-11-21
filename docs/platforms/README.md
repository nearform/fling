<!-- markdownlint-disable MD013 -->

# Platforms

A **platform** puts Fling's core on one cloud's primitives. Every platform meets the same
contract, the [logical platform](../design/platform.md), and has a **platform doc** here that
maps each element of the contract onto its cloud. All platform docs share one template:
1. status and shape;
2. mapping;
3. edge and sites host;
4. domains and TLS;
5. infrastructure as code;
6. deploy and local runtime;
7. capabilities;
8. gaps and open questions;
9. sources.

| Platform | Status | Shape | Infrastructure | Platform doc | Deploy guide |
|---|---|---|---|---|---|
| AWS | supported | edge function (CloudFront Function) | Terraform module | [aws.md](aws.md) | [DEPLOY.md](../../platforms/aws/DEPLOY.md) |
| Cloudflare | supported | one host that routes (one Worker) | setup and deploy scripts, wrangler | [cloudflare.md](cloudflare.md) | [DEPLOY.md](../../platforms/cloudflare/DEPLOY.md) |
| Google Cloud | proposed | one host that routes (Cloud Run) | Terraform (`google`) | [gcp.md](gcp.md) | — |
| Azure | proposed | one host that routes (Container Apps) | Terraform (`azurerm`) | [azure.md](azure.md) | — |
| Fly.io | proposed | one host that routes (Fly Machines) | scripts (no maintained provider) | [fly.md](fly.md) | — |
| Vercel | proposed | edge function (Routing Middleware) | Terraform (`vercel`) | [vercel.md](vercel.md) | — |
| DigitalOcean and self-host | supported | one host that routes (the Node host image) | Terraform (`digitalocean`), Compose or Helm | [digitalocean-self-host.md](digitalocean-self-host.md) | [DigitalOcean](../../platforms/digitalocean/DEPLOY.md), [self-host](../../platforms/node/DEPLOY.md) |

## What each platform uses

| Element | AWS | Cloudflare | Google Cloud | Azure | Fly.io | Vercel | DigitalOcean / self-host |
|---|---|---|---|---|---|---|---|
| Table | DynamoDB | D1 | Firestore | Cosmos DB (one partition) | Postgres | Postgres (Neon) | Postgres |
| Blobs | S3 | R2 | Cloud Storage | Blob Storage | Tigris | Vercel Blob | Spaces / MinIO |
| Route table | CloudFront KVS | Workers KV over D1 | Firestore + cache | Cosmos DB + cache | Postgres + cache | Redis (or Global Config) | Postgres + cache |
| Live hub | API Gateway WebSocket | Durable Objects | Cloud Run + fan-out | Web PubSub | Machines + fan-out | third party | Node host + fan-out |
| Mailer | SES | Email Service | SMTP | Communication Services | SMTP | SMTP | SMTP |
| Site servers | Lambda Web Functions | Worker Loader | Cloud Run per site | Container Apps sessions | a Machine per site | Vercel Sandbox | off (needs a sandbox) |
| Ticks | EventBridge Scheduler | Cron Triggers | Cloud Scheduler | Container Apps jobs | in-process timers | Cron Jobs | in-process timers |
| Secrets | SSM | Worker secrets | Secret Manager | Key Vault | Fly secrets | environment variables | environment / Kubernetes secrets |

The platforms on Node share three building blocks, each written once in `platforms/node`: the
Node host (with its Postgres live fan-out and tick endpoints), the Postgres `Table` and the SMTP
mailer ([§5 of the design](../design/platform.md#5-shared-building-blocks-for-new-platforms)),
and its image (`platforms/node/Dockerfile`). `platforms/node` also runs on its own
(`src/main.ts`), as the e2e's `node` local runtime. Stores that speak the S3 API share `S3Blobs`
(`platforms/s3`).
