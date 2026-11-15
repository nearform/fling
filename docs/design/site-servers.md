<!-- markdownlint-disable MD013 -->

# Design: site servers

Status: v1 as described here; later items in [§19](#19-later).

A **site server** is a small backend beside a static site: one bundled file with its dependencies
inside, run for `/api/*` on the site's own host, in an isolate on Cloudflare and a Lambda Web
Function on AWS, with **site secrets**, logs and a local dev loop. The how-to for authors is
[docs/site-servers.md](../site-servers.md); this is the design record.

Terms are CONTEXT.md's, which defines the ones this design adds: **site server**, **viewer**,
**viewer id**, **site secret**, **invoke**, **start probe**.

## 1. The ask

Fling sites are static. As soon as a prototype needs to call an API with a key, send a form
somewhere or keep a price list off the page, the author leaves Fling for another host, and the
link, the access rules and the review loop go with it. Site servers let a folder carry its own
backend: one bundled file, run for `/api/*` on the site's own host.

- **Fully compiled.** One file, every dependency inside it. The server never runs `npm install`
  and never sees a `package.json`.
- **Isolated per site.** An isolate per version on Cloudflare, a Lambda Web Function per site on
  AWS. No site reaches another's data, the instance's credentials or Fling's storage.
- **Useful on day one.** Outbound network (where the instance allows it) and secrets are in v1, so
  the first servers can proxy an API with a key or post to Slack. Storage comes later (§19).

## 2. What authors write

Two styles, both first-class:

- **Fetch handler.** A module whose default export has a `fetch(request)` method that returns a
  `Response`. It is a convention, not a standard: Cloudflare Workers, Deno and Bun all accept
  `export default { fetch }` as a server, and Hono, Nitro and TanStack Start produce it. It is
  built from WinterTC's Minimum Common API (the Web APIs every server runtime shares: `fetch`,
  `Request`, `Response`, `URL`, streams, Web Crypto); WinterTC (Ecma TC55) does not standardise
  the handler shape itself.
- **Plain Node server.** `http.createServer(…).listen(process.env.PORT)`. It runs unchanged in a
  Cloudflare isolate (through `httpServerHandler` from `cloudflare:node`, which the bundler adds),
  and AWS Web Functions run Node servers natively.

The conformance suite and the e2e scenario run one fixture of each style, so neither can rot.

### Fling's helper: `@nearform/fling/server`

A sub-path of the CLI package. Authors install `@nearform/fling` as a devDependency for types and
`fling dev`; at deploy the bundler swaps in the platform's small implementation, so none of the
CLI ends up in the bundle, and a folder with no `node_modules` still bundles. It gives both styles
the same access to the viewer, files and secrets:

```ts
import { viewer, file, secret } from '@nearform/fling/server'

viewer(request)               // { id, email, guest } | null  (a Request or a Node IncomingMessage)
await file('data/rates.json') // Response: this version's published file
secret('OPENAI_KEY')          // process.env lookup that throws a clear error when unset
```

### What works and what doesn't

| Works | Doesn't |
|---|---|
| Fetch handlers (Hono, itty-router, plain) | Native addons (`.node`) |
| `node:http` servers; Express where Cloudflare's Node compatibility allows (the Guide lists what is known to work) | `child_process`, a writable filesystem |
| `node:crypto`, `Buffer`, streams | WebSockets (Web Functions refuse upgrades) |
| Pure-JS npm packages | State kept in memory: an isolate or environment can go at any time |
| Secrets as `env.NAME` and `process.env.NAME` | Secrets by a reserved name (`RESERVED_SECRET_NAMES`: `AWS_*`, `LAMBDA_*`, `FLING_*`, `_X_AMZN*`, `PORT`, `HOST`, `PATH`, `TZ`, `LANG`, `_HANDLER`, `FILES`), refused with 400 `invalid_secret_name` on every platform |
| Timers and I/O within a request | On Cloudflare, timers or I/O at the module's top level: the isolate refuses them while it loads, so the start fails |

## 3. A worked example

A one-page site that prices a workshop and lets a signed-in member ask the team to book it. The
rates stay on the server, the page only sees the answer, and the booking request goes to Slack
with a webhook URL kept as a site secret. Every file is in
[`examples/site-servers/workshop-quote/`](../../examples/site-servers/workshop-quote/), and the
how-to walks through it. The folder:

```text
workshop-quote/
├── index.html        the page
├── app.js            the page's script
├── style.css
├── server.ts         the server: Fling runs it for /api/*
├── fling.json        the server's entry, the secrets it needs, its health check
├── package.json      build input: the server's dependencies
├── .gitignore        node_modules/, .env and .env.local
├── .env              local values for fling dev (a dotfile: never published)
└── node_modules/     from npm install, on the author's machine only
```

`fling.json`:

```json
{
  "server": "server.ts",
  "secrets": ["SLACK_WEBHOOK_URL"],
  "health": "/api/health"
}
```

Developing and publishing it:

```text
$ npm install
$ echo 'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/…' >> .env
$ fling dev --as ada@example.com
  serving workshop-quote/ at http://localhost:47180  (server: server.ts, rebuilt on save)
  viewer: ada@example.com · secrets: SLACK_WEBHOOK_URL (from .env)

$ fling secrets set workshop-quote --from .env SLACK_WEBHOOK_URL
  ✓ SLACK_WEBHOOK_URL set on workshop-quote (from .env; nothing else read)
$ fling deploy . --name workshop-quote --access members
  bundling server.ts → _fling/server.mjs (474 KB, 102 KB gzipped)
  starting server… GET /api/health 200 in 1.2 s
  ✓ live  https://workshop-quote.<sites domain>/
          server: /api/* · members only · outbound network: open · secrets: SLACK_WEBHOOK_URL
  review  https://<your Fling>/review/workshop-quote
```

The version that goes live is `index.html`, `app.js`, `style.css` and `_fling/server.mjs` (one ESM
file: `server.ts` with hono and zod inside, importing only `node:*`; never served as a file).
`server.ts`, `fling.json`, `package.json` and the lockfile are build inputs and stay behind;
`node_modules/` and dotfiles are never published.

What visitors get, as a signed-in member:

```text
GET  /                  → index.html (static)
GET  /api/health        → 200 {"ok":true}
GET  /api/me            → 200 {"id":"v_3f9a2c71","email":"ada@example.com","guest":false}
POST /api/quote         {"people":12,"days":2,"format":"onsite"}
                        → 200 {"total":11546,"breakdown":["£8000 facilitation","£2040 materials","£1506 on site"]}
POST /api/request       {"people":12,"days":2,"format":"onsite"}
                        → 200 {"sent":true,"total":11546}
POST /api/quote         {"people":0,"days":2,"format":"remote"}
                        → 400 {"error":"People 1–200, days 1–10, remote or on site."}
GET  /api/nope          → 404 {"error":"No such endpoint"}
POST /contact           → 405 (only /api/* takes methods other than GET and HEAD)
GET  /_fling/server.mjs → 404

not signed in:              GET  /api/me      → 302 to sign-in, like any page of a members-only site
from another site's page:   POST /api/request → 403 cross_origin
```

The site's log (`fling logs workshop-quote`):

```text
06:12:03  POST /api/request  200  412 ms  v_3f9a2c71  version 5024258572153ca0
06:12:03  workshop requested v_3f9a2c71 11546
```

## 4. Bundling and build inputs

`fling deploy` (and the local MCP's `fling_deploy`) finds `server.ts` or `server.js` at the top of
the folder, or `"server"` in `fling.json`, and bundles it with esbuild to `_fling/server.mjs`: ESM,
minified, es2022, `platform: neutral`, every import inlined except `node:*`,
`@nearform/fling/server` swapped for the platform's implementation.

- **Build inputs stay behind.** The entry, a `server/` folder for the rest of the server's source
  and private data, `fling.json`, `package.json` and the lockfile are never published. Everything
  else in the folder is published and served as today.
- **Size.** The bundle may be up to 5 MB (Cloudflare allows 10 MB compressed, Web Functions
  512 MB unzipped).
- **Secret scan.** The bundle is scanned like every file.

**Agents on the remote MCP publish dependency-free servers.** Claude on the web and other remote
clients can't run esbuild, and bundling on the API would mean fetching from npm at publish time.
So `fling_publish` accepts a `_fling/server.mjs` that imports only `node:*` and
`@nearform/fling/server`. Anything else is 400 `server_not_bundled`, pointing at
`fling_server_template`: a 30-line router to start from, with a `/api/health` route and the
matching `fling.json`. Developers use the CLI, which bundles anything.

## 5. Versions and files

Nothing about versions changes. `_fling/server.mjs` sits in the manifest and is hashed with
everything else, and a version that has it is marked `server`. Rolling back rolls the code back;
pull and publish-on-a-base carry it forward; retention deletes it with its version. Isolates are
keyed by version, so on Cloudflare a rollback lands on the previous version's isolate, often still
warm.

The server reads the site's own files two ways:

- **Import it.** `import rates from './server/rates.json'`: esbuild inlines it into the bundle.
  Under `server/` it is a build input and never published, so it is the place for data visitors
  mustn't see.
- **`file()` / `env.FILES`.** A read-only view of the version's published files. On Cloudflare an
  entrypoint of the Fling Worker scoped to `sites/<id>/<v>/`, refusing `_fling/`, dotfiles and
  anything outside the version. On AWS the files go into the revision's zip and are read from
  disk.

A published file is a public file: a `data/rates.json` outside `server/` is served at
`/data/rates.json` to anyone who can open the site, whichever way the server reads it.

**Servers run at the site root only; Paths can't have one.** A Path publish containing `_fling/`
is refused (400 `server_on_path`). While a site has a server, `api` is reserved: publishing a
server onto a site with an `api` Path, or making that Path, is 409 `path_conflict`. Path
publishers can't set or list the site's secrets.

## 6. Routing and access

The sites' routing decision (`routeSiteRequest`, `packages/shared/src/site-routing.ts`, one
function on every platform) gains a third outcome, **invoke**. The edge still only maps it onto
its runtime.

1. **Request to `<name>.<sites domain>/api/…`.** Any other path keeps today's rule: GET and HEAD
   only, everything else 405 before any lookup.
2. **Route table lookup.** The route value says `f` when the current version has a server.
   Without it `/api/` is an ordinary folder, so existing sites are untouched.
3. **Cross-origin writes refused.** Any method but GET, HEAD and OPTIONS needs
   `Sec-Fetch-Site: same-origin` or the site's own `Origin`, else 403 `cross_origin`. A request
   with neither (curl, another server) passes: it carries no browser cookies.
4. **Every access check, as for a page.** Private: `fling_site` and the revocation list.
   Restricted: the site pass. A private site's API is private for free.
5. **`{ action: 'invoke', siteId, v, viewer }`.** The viewer is who the checks found, or null on a
   public site or through a share link. A server reached through a share link runs, with viewer
   null.
6. **The shell runs the server.** It drops the browser's cookie and any `x-fling-viewer`, then sets
   `x-fling-viewer: {"id","email","guest"}` from the decision.

**Why the cross-origin rule.** Every site shares the sites domain, and `fling_site` is set on it,
so to a browser `evil.<sites domain>` and `payroll.<sites domain>` are the same site and
`SameSite=Lax` doesn't stop the cookie. Without the rule, any Fling page could POST to another
site's API as the visitor.

**No edge caching; the author's browser caching, made safe.** Every `/api/*` request reaches the
server after the access checks: an edge cache would hand one member's response to another, or to
someone revoked. The author's `Cache-Control` goes to the browser; without one Fling adds
`private, no-store`, and on a site that isn't public, `public` becomes `private`.

`/api/*` is the fixed prefix. The server gets the viewer, never the cookie: the author learns who
is calling without seeing a credential that opens every members' site on the instance. The viewer
carries the email and the viewer id (§12); the Guide says to log the id.

## 7. Who can publish

Only members deploy sites, and any member can make a site public. Servers don't add a new kind of
publisher; they add a new kind of caller: anyone who can open a public site can call its API
directly, without the page, spending the server's secrets, the instance's compute and its IP
reputation.

- **`SERVERS`** instance setting: `off` (the default), `admins`, `groups:<slug>,…` or `members`.
  A new instance action, `server.publish`, in `policy.ts`; without it Publication answers 403
  `servers_not_allowed`.
- **A server on a public site needs a confirmation.** The CLI asks (or takes `--yes`); on MCP the
  first call returns a `public_server` hint and the agent repeats it with
  `confirmPublicServer: true` after asking the user. The message says that anyone can call
  `/api/*` and use its secrets through it.
- **`SERVERS_MAX_SITES`** (default 50) caps the sites with a server, so an account quota can't be
  used up by accident.
- Publishing a server is its own audit event, `site.server_published`. Admins have a kill switch
  per site: the route flag goes and `/api/*` answers 503.

## 8. Site secrets

Fling refuses any file with a secret in it, the bundle included. Secrets live beside the site
instead.

```text
$ fling secrets set workshop-quote SLACK_WEBHOOK_URL < webhook.txt
$ fling secrets set workshop-quote --from .env SLACK_WEBHOOK_URL
$ fling secrets ls workshop-quote
  NAME                SET BY            WHEN
  SLACK_WEBHOOK_URL   ada@example.com   2 minutes ago
$ fling secrets rm workshop-quote SLACK_WEBHOOK_URL
```

- **They belong to the site, not the version.** A rollback runs the old code with today's secrets,
  so a rotated key never comes back.
- **The version declares them**: `"secrets": [...]` in `fling.json`. A publish or rollback to a
  version whose secrets aren't all set is 409 `secrets_missing`, naming them. A publish then waits
  for them: the version stays pending, and setting the last one takes it live, as if the publish
  were retried (the start probe included). If the server then fails to start, the version keeps
  waiting: every later set or remove tries it again, since the fix is often another secret. Only
  the latest publish waits; staging another version of the site, or any version going live, ends
  the wait, as does any other refusal. A rollback is retried by hand.
- **Setting one redeploys**, like `wrangler secret put`. The live version's server runs with the
  secrets as they now are and is probed again; a failed probe is reported in the answer, and the
  secret stays set (that version keeps serving with it, so the fix is another set or a rollback).
  The answer to a set or a remove says what happened: `live` (the live server's probe),
  `deployed` (the waiting publish, live at its URL or refused with the server's log), `missing`
  (what the waiting publish still needs).
- **Owners and publishers set them**, from stdin or with `--from .env NAME…`, which reads only the
  keys named, never as a command-line value. `fling deploy` never uploads `.env`: a local file
  doesn't silently become production secrets. Path publishers can't set them.
- **The site page lists them** by name, with who set each and when. Values are never shown or
  returned.
- **They reach the server** as `env.NAME` and `process.env.NAME` on both clouds, and
  `secret('NAME')` from the helper. On Cloudflare a changed secret gets a fresh isolate; on AWS it
  makes a new revision of the current version.
- **Encrypted at rest** in the Table with AES-256-GCM, under the instance's own `SITE_SECRETS_KEY`
  (32 random bytes, required when servers are on), with the site and the name bound to each value.
  Nothing else uses that key, so rotating the session secret or the site cookie key leaves secrets
  alone. Each value carries the id of the key that sealed it, so a later rotation can keep old
  keys to open what they sealed. At most 20 per site, 8 KB each.

**Publishers can read secrets.** "Never shown" protects against the UI and the API, not against
the code: anyone who can deploy can publish a server that echoes `process.env.SLACK_WEBHOOK_URL`.
The Guide says so plainly, so teams name publishers with that in mind.

## 9. Outbound network

One instance setting, **`SERVERS_EGRESS`**, `none` (the default) or `open`, the same on both
clouds, advertised as the `serversEgress` capability so the CLI, the deploy result and the site
page can say what a server may reach.

| | `none` | `open` |
|---|---|---|
| Cloudflare | `globalOutbound: null`: `fetch` throws | Outbound through the Fling Worker |
| AWS | Revisions use an egress connector into a VPC with no NAT gateway | Lambda's default public egress |

There's no per-host allowlist in v1: AWS can only enforce one with NAT plus Network Firewall
domain rules, a fixed monthly cost per instance. It can come later as an instance option without
changing the author contract.

## 10. Publishing

A version goes live only when its server starts.

1. **Admission.** Bundled (no bare imports), within size, secret-scanned, its declared secrets set,
   the publisher allowed.
2. **`activate`.** Cloudflare: nothing to prepare. AWS: zip the bundle (and the version's files for
   `file()`), create the revision, wait for Active. The AWS timing stays behind the port: if
   revisions routinely take over a minute, the API answers 202 with a status to poll.
3. **Start probe.** One request straight to the new version's server, before the route changes:
   its health path if `fling.json` names one, which must answer 2xx; otherwise `GET /api/`, where
   any HTTP answer, a 404 included, counts. A crash, no listener or 10 s of silence fails it. On
   Cloudflare it also warms the isolate.
4. **Go live.** The route value changes as today, now with `f`.

On failure the version stays pending, the live one keeps serving, and the publish answers 422
`server_failed_to_start` with the first lines of the server's log, which the CLI and MCP show so an
agent can fix it in the same turn. The CLI says `starting server…` while it waits.

**Health checks are the author's, and optional.** Fling reserves no health path and injects none:
an answer from Fling's own code would prove nothing about the author's server, and a required
endpoint would fail every publish that forgot it. With `"health": "/api/health"` in `fling.json`
the probe needs a 2xx from that path, so authors can check what Fling can't (a secret that's set
but malformed, say) at go-live, including the new revision a changed secret makes on AWS. Uptime
monitors call the same path like any endpoint. `fling_server_template` includes one.

## 11. Running it locally: `fling dev`

`fling dev [dir]` (and `fling_dev` on the local MCP) serves the folder as the sites host would and
runs its server beside it, so the loop is: dev, curl, deploy.

- Static files exactly as the edge serves them: trailing slashes, the 404 page, dotfiles hidden,
  `/api/*` to the server, the cross-origin rule.
- The server bundled with deploy's esbuild settings and rebuilt on save, run in Node behind the
  same adapter as the AWS entry.
- `file()` reads the folder. Secrets come from `.env`, with `.env.local` overriding it: the files
  developers already have, already in most `.gitignore` templates, and never published (Fling
  refuses dotfiles in every manifest, and the edge never serves a dot segment).
- Only the secrets `fling.json` declares reach the server, as in production; the rest of `.env` (a
  local database URL, `DEBUG`) stays out. A declared secret missing from `.env` is a warning at
  start, the local `secrets_missing`.
- `--as ada@example.com [--guest]` simulates a signed-in viewer; without it the viewer is null.

Node allows more than a Cloudflare isolate does. `platform: neutral` bundling catches imports that
won't exist; a `--isolate` mode on workerd is later (§19).

## 12. Logs

Seven days of logs, no emails.

- A **`ServerLogs`** port. Cloudflare: a tail consumer in the Fling Worker writes each site's
  output to R2 in hourly chunks. AWS: `read` calls CloudWatch on the site's log group.
- `fling logs <site> [--since 1h] [--follow]`, `fling_logs` on both MCP servers, and a Logs panel
  on the site page. `--follow` polls every 2 s.
- Owners and publishers read them (a new `site.logs` action), and admins from their browser
  session. Kept 7 days on both clouds. Each line names its version.
- Fling logs every request: method, path, status, duration, viewer id, version. That is the
  request log and the source of the site page's request counts.

**Viewer ids, not emails.** `v_3f9a2c71` is the first 8 bytes of
`HMAC(instance key, siteId + ":" + email)`, base32. It is the same for one person on one site and
different on every other site, so a site's logs can follow a user without anyone joining two
sites' logs, and it isn't reversible from the logs. An admin can resolve one when there's a reason:
`fling admin viewer <site> <id>` hashes each member for that site, and the lookup is audited as
`viewer.resolved`.

The author's server still receives the email in `x-fling-viewer`, and Fling can't stop it logging
that. The header carries the id too, and the Guide says to log the id.

## 13. Limits

Defaults per server, raised by admins.

| Limit | Default | Why |
|---|---|---|
| Wall time per request | 30 s | The Web Functions default. Long enough for an LLM call, short enough to stop a stuck loop. One limit for everything, streamed responses included. On Cloudflare a Fling timer. On AWS at most 120 s, CloudFront's longest wait on an origin (`readTimeout`): the adapter advertises it (`SiteServers.maxTimeoutSeconds`), the core runs a longer setting as 120 s and refuses a raise past it with 400 `limit_too_high` |
| CPU per request (Cloudflare only, `SERVER_CPU_MS`) | 1 s | Normal API work takes milliseconds; this stops miners. AWS has only the wall time |
| Requests per site | 100 rps | AWS `rateLimit` steps by 100; on Cloudflare a rate-limit binding keyed by site, `SERVER_RPS` × 10 per 10 s window and counted per location, so approximate |
| Environments per site (AWS only, `SERVER_ENVIRONMENTS`) | 2 | The minimum `maxEnvironments`; each takes up to 64 concurrent requests. Cloudflare has no environments to count |
| Request body | 10 MB | Form posts and small uploads |
| Bundle | 5 MB | Well under both platforms' caps |
| Secrets per site | 20, 8 KB each | Enough for real apps, too small to be storage |

Each is an instance config value (`SERVER_TIMEOUT_SECONDS` and so on), with an admin override per
site on the site page. Authors can't raise their own.

## 14. Cloudflare: the Worker Loader

An isolate per version, loaded from R2. The Fling Worker already serves every sites host. For
invoke it asks the `worker_loaders` binding for an isolate named after the version and its
secrets. The first time, the loader reads the bundle from R2; after that the warm isolate is
reused.

```ts
// platforms/cloudflare/src/sites.ts
const worker = env.LOADER.get(`site:${siteId}:${v}:${secretsHash}`, async () => ({
  compatibilityDate: '2026-10-19',
  compatibilityFlags: ['nodejs_compat'],
  mainModule: 'server.mjs',
  modules: { 'server.mjs': { js: await (await bucket.get(key)).text() } },
  env: { ...secrets, FILES: ctx.exports.SiteFiles({ props: { prefix } }) },
  globalOutbound: egress === 'none' ? null : undefined,
  limits: { cpuMs: 1000 },
}))
return worker.getEntrypoint().fetch(request)
```

Why this one: no upload step (the version's file is the code); 15–20 ms for a version's first
request and 2–4 ms warm, locally; egress and `FILES` are one line each.

To watch: open beta since 24 March 2026, Workers Paid only; $0.002 per unique Worker loaded per day
(waived in the beta), plus normal request and CPU pricing.

**Build on the beta, keep the exit cheap.** Everything Cloudflare-specific stays in the Cloudflare
adapter and `sites.ts`. If the terms turn bad, the fallback is Workers for Platforms: a dispatch
namespace, with the bundle uploaded at activate. The `servers` capability is off by default on
Cloudflare instances until the beta ends; an operator turns it on with `SERVERS`.

What differs on Cloudflare:

- **The module loads inside a request.** The isolate refuses timers and I/O at the module's top
  level, so a bundle that starts a timer or fetches something while it loads fails its start
  probe. Start them in the first request.
- **The run is the target.** activate seals the options into R2 and returns the run's name (a
  keyed hash of them), which the core keeps as the route value's `t`; the sites host loads the
  isolate by it, whichever Worker isolate activated it.
- **Requests per site are approximate.** The rate limit binding counts per location over a 10 s
  window (`SERVER_RPS` × 10 per 10 s), not per second across the world.
- **No environments.** `SERVER_ENVIRONMENTS` has no meaning here; `SERVER_CPU_MS` is the
  isolate's `limits.cpuMs`, which AWS has no equivalent for. A request Cloudflare stops at it
  answers 502 `server_cpu_limit`.
- **The clock stands still.** `Date.now()` advances during a request only across I/O, so a busy
  loop timed by it never ends; the CPU limit stops it.

## 15. AWS: a Lambda Web Function per site, a revision per version

Classic Lambda function URLs behind CloudFront OAC need the browser to send a SHA-256 of every POST
body, which rules them out. Lambda Web Functions fit almost one for one:

| Fling | Web Functions |
|---|---|
| Site with a server | A Web Function with one HomeRegion endpoint, IamAuth |
| Version | A revision: immutable code and config, from a zip in a versioned S3 bucket |
| Go live / rollback | The endpoint's revision weights |
| Kill switch | `rateLimit: 0` → 503 `EndpointDisabled` |
| Limits | `rateLimit`, `maxEnvironments`, `timeoutSeconds` |
| Secrets | Revision `environmentVariables` (a changed secret makes a new revision) |
| Egress none | An egress connector into a VPC with no NAT |
| Logs | `/aws/lambda/web/<function>`, 7-day retention |

A fetch handler is served by a 30-line `index.mjs` that Fling adds to the zip. The CloudFront
Function switches the origin for invoke, using the endpoint host the route value carries:

```js
// edge/src/cloudfront.js
cf.updateRequestOrigin({
  domainName: decision.target, // xyz.lambda-web.eu-west-1.on.aws
  originAccessControlConfig: {
    enabled: true, signingBehavior: 'always-amz-auth',
    signingProtocol: 'sigv4', originType: 'lambda',
  },
  timeouts: { readTimeout: 120 }, // CloudFront's most; the entry enforces the site's limit
})
```

Two things CloudFront decides for the whole sites distribution, and how Fling keeps out of them:

- **The wait.** The distribution's origins wait 30 s; the router asks for 120 s on every invoke,
  the most CloudFront allows without a quota increase. That caps `SERVER_TIMEOUT_SECONDS` on AWS:
  the adapter advertises 120 (`SiteServers.maxTimeoutSeconds`), the core runs a longer setting as
  120 and refuses an admin's raise past it (400 `limit_too_high`).
- **The error page.** The distribution's custom error responses turn every origin 403 and 404 into
  the sites' 404 page, and a viewer-response function never runs on an answer of 400 or more. So
  the Web Function entry sends a server's 403 or 404 as `300` with `x-fling-status: <real>`, and a
  viewer-response function on `/api/*` only (`edge/src/server-status.js`) puts the status back
  and removes the header. 300 is below 400, isn't a redirect without a `Location`, may carry a
  body, and if the restore were ever skipped a client still sees neither a success nor a
  redirect. A server's own 300 has no header and passes through unchanged.

**The API creates Web Functions at publish time, inside an IAM fence.** Terraform defines the
fence and the shared parts; the API creates each site's function, endpoint and revisions.
`lambda-web:*` only on `fling-<instance>-site-*` with a `fling:instance` tag; `iam:PassRole` only
on the one no-permission server role; `s3:PutObject` only on the zip bucket; no other compute.
Deleting a site or retention removes its function, and an hourly sweep deletes any tagged function
with no site. Terraform also adds the `/api/*` cache behaviour (all methods, no caching,
`AllViewerExceptHostHeader`).

The adapter is built from the documentation; §18 lists what the live check confirms.

## 16. Architecture

Ports, capabilities, policy.

```ts
// apps/api/src/ports
interface SiteServers {
  /** ready a version's server; the route value carries what the edge needs */
  activate(site: SiteRef, version: VersionRef, opts: ServerOptions): Promise<{ target: string }>
  /** the start probe: one request to this version's server before it goes live */
  probe(site: SiteRef, version: VersionRef): Promise<ProbeResult>
  /** a secret changed: Cloudflare renames the isolate, AWS makes a revision */
  reconfigure(site: SiteRef, version: VersionRef, opts: ServerOptions): Promise<{ target: string }>
  /** the site goes dark (kill switch, archive) or comes back */
  setEnabled(site: SiteRef, enabled: boolean): Promise<void>
  /** retention or delete */
  retire(site: SiteRef, version?: VersionRef): Promise<void>
}

interface ServerLogs {
  append?(site: SiteRef, lines: LogLine[]): Promise<void>
  read(site: SiteRef, since: Date, limit: number): Promise<LogLine[]>
}
```

- **Write once.** Admission, the server mark, the route flag, the cross-origin rule, the viewer and
  its id, secrets, policy and the probe's rules live in the core. Platforms only adapt.
- **Every platform passes.** Conformance suites for `SiteServers` and `ServerLogs` serve the same
  two fixtures (fetch handler and `node:http`) through each adapter. The e2e scenario publishes the
  worked example on both local runtimes.
- **Capabilities.** `servers` and `serversEgress` in `/.well-known/fling`. Clients read them;
  nothing checks which cloud it is on.
- **Policy.** `server.publish` (instance), `site.secrets` and `site.logs` (owners and publishers),
  all in `policy.ts`.

Instance configuration:

| Value | Default | Meaning |
|---|---|---|
| `SERVERS` | `off` | Who may publish a server: `off`, `admins`, `groups:<slug>,…` or `members` |
| `SERVERS_EGRESS` | `none` | Whether servers reach the internet: `none` or `open` |
| `SERVERS_MAX_SITES` | `50` | Sites with a server at once |
| `SERVER_TIMEOUT_SECONDS` | `30` | Wall time per request, streams included; admins raise it per site |

## 17. Reviews

One banner, nothing else. Review mode needs no new machinery: the review shell frames the site on
its own origin, so reviewers are real viewers and the server sees them in `x-fling-viewer`;
comments anchor by selector and quote, as they do on pages drawn by JavaScript; a comment records
its version, and the server is part of the version.

What changes is that two reviewers can see different things (a response that depends on who is
calling, or on outside data), and that what a reviewer does can be real (a button that posts to
Slack). So the review page says so, above the frame, while the live version has a server (the site
object's `hasServer`):

> This site has its own server. What you see may differ from what other reviewers see, and actions
> you take on it are real.

No review flag for servers, no captured API calls on comments, no replay: authors who want a
review-safe site build it that way themselves.

## 18. Evidence and open checks

A throwaway spike (branch `spike/site-functions`, never merged) ran fixtures under `wrangler dev`,
published through the real CLI and API, routed by the real decision and served by the real Worker:

| Check | Result |
|---|---|
| Bundle (Hono + zod) | 473 KB · 101 KB gz · 70 ms |
| First request of a version / warm | 15–20 ms / 2–4 ms |
| POST with JSON, zod validation | 200 / 400 |
| POST outside `/api/` | 405 |
| `GET /_fling/server.mjs` | 404 |
| Browser-sent `x-fling-viewer` | Dropped |
| `node:crypto`; `node:http` server in the isolate | Work |
| Outbound fetch with `globalOutbound: null` | Blocked |
| 5 s busy loop, `cpuMs: 50` | Not cut off locally; on a real account stopped ("exceeded CPU time limit", 502 `server_cpu_limit`) |
| New version / rollback | New isolate / previous isolate, still warm |
| Members site: no cookie / member cookie | 302 / 200 with the viewer |
| Server reads `data/rates.json` by import and by `FILES` | Both work; `FILES` refuses `_fling/`, dotfiles, outside the version |
| Secret in loader env | `env.X` and `process.env.X`, both styles |
| Same bundle as a Node HTTP server (AWS entry) | Works |

Still to check, none of which changes the author contract:

- **AWS, live:** revision preparation time, cold starts, the origin switch with
  `always-amz-auth`, Terraform provider support for `lambda-web`, Region availability, and about
  50 revisions kept per function (a rollback past that recreates the revision from the stored
  bundle). Decides whether publishing needs 202 and polling.
- **Secret scanner:** how often do minified npm bundles trip it? Bundle the top 200 packages and
  see.

## 19. Later

- Per-host egress allowlists, as an instance option.
- `"cors"` in `fling.json`, to opt in to cross-origin calls.
- `fling dev --isolate`, running the server on workerd.
- A per-site store.
- Edge caching for public sites, keyed by version.
- Servers on Paths.
