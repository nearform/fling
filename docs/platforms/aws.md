<!-- markdownlint-disable MD013 -->

# Platform: AWS

How Fling meets the [logical platform](../design/platform.md) on AWS. Deploying an instance:
[platforms/aws/DEPLOY.md](../../platforms/aws/DEPLOY.md).

## 1. Status and shape

**Status:** supported. Production instances run it, and it is deployed by the `v<x.y.z>` release
tag.

**Shape:** edge function. A CloudFront Function makes the routing decision at the edge against a
CloudFront KeyValueStore, then serves from S3. The API is one Lambda behind a function URL and
CloudFront. Everything is serverless and in one region, except CloudFront and its certificate
(us-east-1).

## 2. Mapping

| Element | AWS service | Adapter | Notes |
|---|---|---|---|
| Table | DynamoDB, one on-demand table, `PK`/`SK`, no GSIs | `platforms/aws/src/table/dynamo.ts` | `ConsistentRead` everywhere. `BatchGetItem` (100 keys a request) for `getMany`. `TransactWriteItems` for `transact`. `ttl` (epoch seconds) mirrors `expiresAt`, and reads also filter expired items because TTL lags by up to ~48 h |
| Blobs | S3 (`sites` bucket) | `platforms/s3/src/blobs.ts` | Presigned PUT signs `x-amz-checksum-sha256`, so S3 itself enforces the bytes. `CopyObject`, then `ListObjectsV2` with `DeleteObjects` for prefixes |
| Route table | CloudFront KeyValueStore | `platforms/aws/src/route-table/cloudfront.ts` | Data-plane API (SigV4A). Writes need the store's ETag, so the adapter caches it and retries when stale. Propagation is eventual, so `waitReady` polls |
| Sites host | CloudFront Function (`cloudfront-js-2.0`) | `edge/src/cloudfront.js`, built by `edge/build.mjs` | See §3 |
| Live hub | API Gateway WebSocket API (stage `live`) | `platforms/aws/src/live.ts` | `$connect`/`$default`/`$disconnect` go to the API Lambda. Connections are live connection records in DynamoDB (2 h TTL). Messages go out with `PostToConnection`; a 410 deletes the connection |
| Mailer | SES v2 `SendEmail` | `platforms/aws/src/mail/ses.ts` | One send per recipient. The SES identity is brought by the operator, and the IAM grant is limited to the `from` address |
| Site servers | Lambda Web Functions, one per site, a revision per version | `platforms/aws/src/servers/` | `live` endpoint reached by CloudFront through OAC; `probe` for the API role; `goLive` moves revision weights. Egress `none` uses a VPC network connector. 120 s wall-time cap |
| Server logs | CloudWatch Logs (`FilterLogEvents`) | `platforms/aws/src/servers/server-logs.ts` | Read-only; the function writes its own log |
| Ticks | EventBridge Scheduler invoking the Lambda | `platforms/aws/src/lambda.ts` | `{"fling":"notify"}` every minute (with mail); `{"fling":"maintain"}` every 15 minutes, up to 4 minutes of the function's timeout (300 s by default) |
| Migrations | Lambda invoke `{"fling":"migrate"}` | `platforms/aws/src/lambda.ts` | Looped by the deploy until done |
| Secrets | SSM Parameter Store SecureStrings under `SSM_PREFIX` | `platforms/aws/src/secrets.ts` | Read at cold start. Generated secrets are written write-only, never into state. The site HMAC key is copied into the KVS as `cfg:site-hmac` |
| Sign-in | (core OIDC) | — | The client secrets are in SSM |

## 3. Edge and sites host

`edge/src/cloudfront.js` is a viewer-request function on the sites distribution. It calls
`routeSiteRequest` with `cf.kvs()` lookups and `crypto.createHmac`:
- A rewrite changes the URI to `/sites/<id>/<v><path>`, served from S3 through OAC.
- A response is returned from the function.
- An invoke strips cookies, sets `x-fling-viewer` and `x-fling-site`, and switches the origin to
  the site's Web Function with `cf.updateRequestOrigin`.

`edge/build.mjs` refuses syntax the runtime lacks and caps the router at 9,800 bytes. A second
function, `edge/src/server-status.js`, maps a site server's `x-fling-status` back to 403 or 404.

The known limit: a viewer-request function never sees the response, so files S3 serves do not
carry the decision's headers. Only responses the function makes itself do.

**View counts.** A page's beacon posts to `/_fling-seen` on the site's host. The sites distribution
has a behaviour for that path with the site router attached and a second origin, `api`: the function
URL, with the same `X-Origin-Verify` header the app distribution sends. The router makes its usual
access checks and the cross-origin check, answering a refusal at the edge. When it lets the beacon
through, it sets `x-fling-site` and leaves the origin as it is, so the request goes to the API's
`POST /_fling-seen`. Each warm function counts views in memory (`ViewCounter`) and writes them at
most every 10 seconds, after a view. The notify and maintain ticks write what the function running
them holds. Views a frozen function still holds are lost when Lambda reclaims it. With a module
version that lacks the behaviour, CloudFront refuses the beacon's POST and nothing is counted.
Because the sites distribution reaches the function, the function's environment can't name the
distribution. Its ARN, which site servers need, is the SSM parameter `sites-distribution-arn`,
beside the secrets. So deploy a release that reads it before you apply that module version to an
instance with servers on.

The cost is about $1.50 per million views. Lambda requests and duration come to about $0.50.
CloudFront's extra request costs $0.75 to $1.00. DynamoDB costs next to nothing, since views are
written in batches.

## 4. Domains and TLS

- One hostname serves the app, and `*.hostname` serves the sites (the sites domain equals the app
  domain).
- One ACM certificate in us-east-1 covers both. Terraform validates it by DNS in Route53, and A
  and AAAA alias records point both names at the two distributions.
- The API Lambda refuses requests without the `X-Origin-Verify` header that CloudFront adds, so
  the function URL cannot be reached directly.

## 5. Infrastructure as code

The Terraform module is [`platforms/aws/infra`](../../platforms/aws/infra). It is versioned by
`infra-aws-v<x.y.z>` tags, separate from release tags, and consumed by
`source = "git::…//platforms/aws/infra?ref=<tag>"`. Terraform owns the shape, `deploy.yml` owns
the code, and the app owns KVS keys and table items.

| File | Resources |
|---|---|
| `main.tf` | Log group; DynamoDB table (PITR, deletion protection) |
| `api.tf` | Lambda (arm64, Node 24) with a placeholder zip; function URL; permissions |
| `live.tf` | API Gateway v2 WebSocket API, routes and stage |
| `edge.tf` | ACM certificate and validation; KeyValueStore; CloudFront Functions; OACs; `app` and `sites` distributions; Route53 records |
| `storage.tf` | `ui` and `sites` buckets with policies and lifecycle rules |
| `secrets.tf` | SSM parameters, generated and manual |
| `iam.tf` | API role; GitHub OIDC deploy role (trusted on repo, owner and environment ids) |
| `maintenance.tf`, `mail.tf` | Scheduler schedules and roles; SES grant |
| `servers.tf` | Server role, zips bucket, IAM fence, and with egress `none` a VPC and network connector |

`infra/tests/*.tftest.hcl` run against mocked providers in the gate (`scripts/check-terraform.mjs`).

## 6. Deploy and local runtime

- **Deploy:** `.github/workflows/deploy.yml` runs after a release, assuming the deploy role over
  GitHub OIDC. In order, it:
  1. builds `lambda.zip` (with `instance.json`), the UI, the edge functions and the `.mcpb`;
  2. updates the function;
  3. loops `migrate`;
  4. polls `/.well-known/fling`;
  5. syncs the UI and the sites' own pages;
  6. publishes the site router after a `test-function` check;
  7. invalidates caches.

  The `deploy` Terraform output becomes the `AWS_DEPLOY_CONFIG` GitHub variable.
- **Local runtime:** `pnpm dev` (`apps/api/src/dev.ts`) runs the real CloudFront Function through
  the `@fling/edge` harness, over a file table and fs blobs. `pnpm e2e` runs it as the "aws"
  runtime.
- **Emulators:** DynamoDB Local and MinIO in CI (`platforms/aws/tests/services.ts`). The
  KeyValueStore has no emulator.

## 7. Capabilities

- Every capability can be on.
- `servers` needs `servers.enabled` in the module.
- `serversEgress` is on unless the module's egress is `none`.
- `email`, `invites` and the email channel of notifications need `var.mail`.

## 8. Gaps and open questions

- **The route table's 5 MB.** CloudFront KeyValueStore holds 5 MB per store, and a function has
  one store. In the `json` route format that is about 30–50k live sites, fewer with many Paths or
  share links; in `compact` (Admin → Routes) about two to three times as many. Maintenance logs
  the store's size every run and `route table nearly full` from 70%, which the module turns into
  the `RouteTableFull` alarm (`alarm_actions`). Beyond that, sites would need to be served from
  DynamoDB when they miss in the store. Each live Path is a key in the same store, so the module
  sets `PATHS_PER_SITE_MAX` to 200 (`paths_per_site`) where the core's default is 1000: a few
  sites with 1000 Paths each could otherwise fill it for everyone.
- **The decision's headers on S3 responses.** These need a response-side function or a response
  headers policy.
- **The KeyValueStore adapter is not covered by `routeTableConformance`,** because there is no
  emulator.

## 9. Sources

- [CloudFront Functions runtime 2.0](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-20.html)
- [CloudFront KeyValueStore](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html)
- [S3 checksums on upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)
- [DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)
