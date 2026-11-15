---
paths:
  - packages/shared/src/site-routing.ts
  - packages/shared/src/site-labels.ts
  - packages/shared/src/route-keys.ts
  - packages/shared/src/kvs.ts
  - edge/**
  - platforms/cloudflare/src/sites.ts
  - platforms/*/src/route-table/**
---

# Site routing

- `routeSiteRequest` in `packages/shared/src/site-routing.ts` is the single routing decision.
  `edge/build.mjs` bundles it into the CloudFront Function, and the Worker's sites host
  (`platforms/cloudflare/src/sites.ts`) calls it directly. Change routing there, never in a shell.
- The routing files run inside CloudFront Functions (cloudfront-js-2.0: a restricted runtime with no
  Node built-ins besides `crypto` and a small code-size limit). That is why they have their own Biome
  overrides. Keep them dependency-free, and run `pnpm --filter @fling/edge build` and its tests
  after a change.
- Node is more permissive than that runtime, so local tests can pass on code CloudFront rejects. For
  example, `await` must be a whole statement or assignment, never inside call arguments or a
  ternary. `edge/build.mjs` checks what it can. The deploy runs the function in CloudFront
  (`test-function`) before publishing it, because an error there takes every site down.
- The edge enforces `site.view` from the visibility stored in the route table, and the API keeps
  the route table in step on every write. `apps/api/tests/policy.test.ts` keeps the edge and
  `policy.ts` in agreement.
- Site servers are part of the decision, not of any shell: `invoke` (for `/api/*` on a site whose
  route value says `f`), the cross-origin rule, the viewer and its id (`viewerIdOf`) and the 503
  of a stopped server are decided in `site-routing.ts`. A shell only carries an invoke out: drop
  the browser's cookies and `x-fling-viewer`, set the decision's viewer, send it to `target` or its
  own runtime, and give the response the Cache-Control `serverCacheControl`
  (`packages/shared/src/site-server.ts`) makes. Nothing under `/_fling/` is a site's file.
- `edge/build.mjs` wraps the bundle in a function before minifying, so every name but `handler` is
  shortened. Keep the deployable size (printed by the build) well under `SITE_ROUTER_MAX_BYTES`.
- On Cloudflare, KV sits in front of the D1 route table and a KV miss is answered from D1. A new key
  is visible immediately; a changed key can be up to about a minute stale. Don't build anything that
  depends on a changed route being seen at once.
