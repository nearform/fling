<!-- markdownlint-disable MD013 -->

# Site servers

A site server is a small backend that ships inside a Fling site. You put a `server.ts` (or
`server.js`) next to your `index.html`, and Fling runs it for every request to `/api/*` on the
site's own address, `https://<name>.<sites domain>/api/…`. Everything else is still the static
files. The server keeps its keys as site secrets, sees who is calling, and is published, versioned,
rolled back and reviewed with the rest of the site: same link, same access, same review page.

This page is for developers and for agents. The design record is
[docs/design/site-servers.md](design/site-servers.md). Every example below is complete and lives in
[`examples/site-servers/`](../examples/site-servers/).

- [When to use one](#when-to-use-one)
- [Before you start](#before-you-start)
- [What works, what doesn't, and the limits](#what-works-what-doesnt-and-the-limits)
- [The folder](#the-folder)
- [fling.json](#flingjson)
- [The helper: viewer, file, secret](#the-helper-viewer-file-secret)
- [Develop: fling dev](#develop-fling-dev)
- [Secrets: fling secrets](#secrets-fling-secrets)
- [Publish: fling deploy](#publish-fling-deploy)
- [Logs: fling logs](#logs-fling-logs)
- [From an agent](#from-an-agent)
- [Access, the viewer and caching](#access-the-viewer-and-caching)
- [Examples](#examples)
- [When it goes wrong](#when-it-goes-wrong)

## When to use one

Use a site server when a static page is nearly enough but needs one thing a browser can't do
safely:

- **Call an API with a key.** An LLM, a payment sandbox, a search index: the key stays on the
  server and the page never sees it.
- **Send something somewhere.** Post to a Slack webhook, open a ticket, send a form to a CRM.
- **Keep data off the page.** Price lists, margins, scoring rules: the page asks for an answer and
  only ever sees the answer.
- **Answer differently for each person.** The server knows who is signed in.

Don't use one for a database-backed app, background jobs or anything that needs to remember state
between requests: there is no storage yet, and the server can be stopped and started at any time.
For collecting structured answers from reviewers, use a form (`fling.forms.json`) instead; it
needs no server.

## Before you start

Site servers are an instance setting, off unless the operator turns them on. Your Fling advertises
what it allows at `/.well-known/fling`:

```sh
curl -s https://<your Fling>/.well-known/fling | jq '.capabilities | {servers, serversEgress}'
```

- `servers`: whether you may publish a server. The operator chooses who: nobody (`SERVERS=off`,
  the default), admins, named groups, or every member. If you aren't allowed, a deploy with a
  server answers 403 `servers_not_allowed`.
- `serversEgress`: whether a server may reach the internet. `false` (the operator's
  `SERVERS_EGRESS=none`, the default) means no outbound network at all: `fetch` to another host
  throws. `true` (`SERVERS_EGRESS=open`) means the public internet. An LLM proxy or a Slack webhook
  needs it.

You also need the CLI, version 0.13 or later:

```sh
npm install -g @nearform/fling
```

## What works, what doesn't, and the limits

Write the server in either style; both are first-class:

- **A fetch handler**: a module whose default export has `fetch(request)` returning a `Response`.
  Hono, itty-router and plain code all produce one.
- **A plain Node server**: `http.createServer(…).listen(process.env.PORT)`.

| Works | Doesn't |
|---|---|
| Fetch handlers (Hono, itty-router, plain) | Native addons (`.node` files) |
| `node:http` servers; Express where the platform's Node compatibility allows | `child_process`, writing to disk |
| `node:crypto`, `Buffer`, streams, `fetch` | WebSockets |
| Pure-JavaScript npm packages, bundled in | Keeping state in memory between requests: the server can stop at any time |
| Secrets as `process.env.NAME`, `env.NAME` or `secret('NAME')` | Calling other hosts when the instance's `serversEgress` is false |
| Timers and I/O inside a request | On Cloudflare, timers or I/O at the module's top level, while it loads: the start fails. Start them in the first request instead |
| Time from `Date.now()` across I/O | On Cloudflare, `Date.now()` stands still during a request except across I/O, so a busy loop timed by it never ends (and is stopped at the CPU limit, 502 `server_cpu_limit`) |
| | A secret named `AWS_*`, `LAMBDA_*`, `FLING_*`, `_X_AMZN*`, `PORT`, `HOST`, `PATH`, `TZ`, `LANG`, `_HANDLER` or `FILES` (Fling's and the platforms'): refused with 400 `invalid_secret_name` everywhere |

Limits, per site. Admins can raise them for one site; authors can't.

| Limit | Default |
|---|---|
| Wall time per request, streamed responses included | 30 s (at most 120 s on AWS) |
| CPU time per request (Cloudflare only, `SERVER_CPU_MS`) | 1 s |
| Requests per site | 100 a second (on Cloudflare, counted per location over 10 s) |
| Copies running at once (AWS only, `SERVER_ENVIRONMENTS`) | 2 |
| Request body | 10 MB |
| Bundle (`_fling/server.mjs`) | 5 MB |
| Site secrets | 20 per site, 8 KB each, never empty |
| Sites with a server, across the instance | 50 |

The 30 seconds is the whole request: if a streamed answer is still going at 30 s, it is cut off.
On AWS a request can't be given more than 120 s, how long CloudFront waits on a server: an admin's
raise past it is refused (`limit_too_high`), and a longer instance setting runs as 120 s.

Each platform enforces what it has. `SERVER_CPU_MS` applies on Cloudflare only (AWS measures only
the wall time), and `SERVER_ENVIRONMENTS` on AWS only (a Cloudflare isolate has no environments
to count). On Cloudflare the requests per site are counted by the rate limit binding per
location, as `SERVER_RPS` × 10 in a 10-second window, so the limit is approximate and a burst
within the window passes.

Servers run only at the site root: a Path can't have one.

## The folder

```text
my-site/
├── index.html        published
├── app.js            published
├── data/
│   └── products.json published: anyone who can open the site can fetch it
├── server.ts         build input: bundled, never published
├── server/           build input: the rest of the server's code and private data
│   └── costs.json
├── fling.json        build input: read by Fling, never served
├── package.json      build input: the server's dependencies
├── package-lock.json build input
├── .gitignore        node_modules/, .env, .env.local
├── .env              local secrets for fling dev: a dotfile, never published or uploaded
└── node_modules/     never published
```

`fling deploy` bundles the server with esbuild into one file, `_fling/server.mjs`, with every
dependency inside it, and publishes that with the static files. The server never runs
`npm install`. The bundle is part of the version: rolling back rolls the code back too.
`/_fling/server.mjs` is never served; asking for it is a 404.

What stays behind: the entry file, everything under `server/`, `fling.json`, `package.json` and
the lockfile. Everything else is published as it always is, and dotfiles, `node_modules/` and
gitignored files never are.

## fling.json

```json
{
  "server": "server.ts",
  "secrets": ["SLACK_WEBHOOK_URL"],
  "health": "/api/health"
}
```

| Key | Meaning |
|---|---|
| `server` | The entry to bundle. Optional when it is `server.ts` or `server.js` at the top of the folder |
| `secrets` | The site secrets this version needs. A publish (or rollback) with any of them unset is refused, and `fling dev` passes only these from `.env` |
| `health` | A path under `/api/` that must answer 2xx before the version goes live. Optional |

Without `health`, Fling's start probe calls `GET /api/` and accepts any HTTP answer, a 404
included: it only proves the server starts. With it, your server can check what Fling can't, such
as a secret that is set but malformed. Keep the health route cheap: it runs on every publish, and
must not call a paid API or post anywhere.

## The helper: viewer, file, secret

`@nearform/fling/server` gives both styles the same three functions. Install the CLI package as a
dev dependency for the types and for `fling dev`; at deploy the bundler swaps in the platform's own
small implementation, so none of the CLI ends up in your bundle.

```sh
npm install --save-dev @nearform/fling
```

```ts
import { viewer, file, secret } from '@nearform/fling/server'

viewer(request)               // { id, email, guest } or null; a Request or a Node IncomingMessage
await file('data/rates.json') // a Response: this version's published file
secret('OPENAI_KEY')          // the site secret; throws a clear error when it isn't set
```

You don't need the helper. The viewer is the `x-fling-viewer` request header (JSON), and secrets
are `process.env.NAME`; the [Node example](#b-the-same-apime-as-a-plain-nodehttp-server) uses
neither import.

## Develop: fling dev

```sh
fling dev                        # this folder
fling dev ./my-site --as ada@example.com
fling dev --as ada@example.com --guest
fling dev --port 8080 --spa      # another port; index.html for unknown paths, as deploy's --spa
```

`fling dev` serves the folder the way the sites host does, at `http://localhost:47180` (else a
free port), and runs
the server beside it, bundled with deploy's settings and rebuilt when you save:

- Static files exactly as published: trailing slashes, the 404 page, dotfiles hidden, `/api/*` to
  the server, the cross-origin rule.
- `file()` reads the folder.
- **Secrets come from `.env`, with `.env.local` overriding it.** Only the names in `fling.json`'s
  `secrets` reach the server, as in production; anything else in `.env` (a local database URL,
  `DEBUG`) stays out. A declared secret missing from both files is a warning when it starts.
- **`--as <email>`** makes requests arrive as that signed-in viewer, with a viewer id made as
  production makes one, and `--guest` as a guest. Without `--as` the viewer is null, as on a
  public site.
- Every request line and everything the server prints appear in the terminal, as `fling logs`
  prints them. A bundle that fails to build keeps the last one running.

The local server runs in Node, which allows more than some platforms do. The bundler targets a
neutral platform, so an import that won't exist in production fails at bundle time rather than
after you deploy.

The loop is: `fling dev`, try it with the page or `curl`, then `fling deploy`.

```sh
curl -s localhost:47180/api/me
curl -s -X POST localhost:47180/api/quote -H 'content-type: application/json' \
  -d '{"people":12,"days":2,"format":"onsite"}'
```

`curl` sends no `Origin` or `Sec-Fetch-Site`, so the cross-origin rule lets it through.

## Secrets: fling secrets

Fling refuses to publish any file with a secret in it, the bundle included, so keys live beside
the site as **site secrets**. Owners and publishers of the site set them; values are never shown
again, by the CLI, the API or the web app.

```sh
fling secrets set my-site SLACK_WEBHOOK_URL < webhook.txt     # the value from stdin
fling secrets set my-site SLACK_WEBHOOK_URL                   # asked for, not shown, on a terminal
fling secrets set my-site --from .env SLACK_WEBHOOK_URL API_KEY  # only the keys you name
fling secrets ls my-site
fling secrets rm my-site SLACK_WEBHOOK_URL
```

```text
$ fling secrets set my-site --from .env SLACK_WEBHOOK_URL
  ✓ SLACK_WEBHOOK_URL set on my-site (from .env; nothing else read)
  The live server (version 5024258572153ca0) restarted with it.

$ fling secrets ls my-site
  NAME                SET BY            WHEN
  SLACK_WEBHOOK_URL   ada@example.com   2 minutes ago
```

- A value never goes on the command line, where it would land in your shell history.
- `--from .env NAME…` reads only the names you list, nothing else in the file. Without `--from`,
  set one at a time.
- `fling deploy` never uploads `.env`: a local file never quietly becomes production secrets.
- Secrets belong to the site, not the version. A rollback runs the old code with today's secrets,
  so a rotated key never comes back.
- Setting a secret puts it to use at once, and says what it did: the live server restarts with
  the new value, or the version a deploy left waiting for its secrets goes live (see
  [Publish](#publish-fling-deploy)). There is no need to deploy again.
- `fling secrets ls` lists the names, who set each and when, the names the live version declares
  but aren't set, and, while a version waits for its secrets, which version it is, what it
  declares and what it still needs.
- The Secrets section of the site page's Server tab lists them too, with who set each and when,
  and sets, replaces and removes them. A version waiting for secrets marks the Server tab.

> **Warning** Anyone who can publish the site, and may publish servers, can read its secrets, by
> publishing a server that prints them. Choose publishers with that in mind.

## Publish: fling deploy

```sh
fling deploy . --name workshop-quote --access members
```

Once the site's secrets are set, a deploy goes straight live:

```text
  bundling server.ts → _fling/server.mjs (465 KB, 100 KB gzipped)
  starting server… GET /api/health answered in 1.2 s
  ✓ Deployed workshop-quote (4 files, 467 KB; uploaded 4, version f12ba1d8273dc664)
  https://workshop-quote.<sites domain>/
  Share for feedback (reviewers sign in to <your Fling>): https://<your Fling>/review/workshop-quote
  server: /api/* · members only · outbound network: open · secrets: SLACK_WEBHOOK_URL
  logs: `fling logs workshop-quote`
```

What happens, in order:

1. **Bundle.** The CLI bundles the entry to `_fling/server.mjs`.
2. **Admission.** Fling checks the bundle imports nothing but `node:*`, fits the size limit, has no
   secrets in it, that every secret in `fling.json` is set, and that you may publish servers.
3. **Start probe.** Fling starts the new version's server and calls its health path (or
   `GET /api/`) before anything changes for visitors. A crash, no listener or 10 seconds of silence
   fails it.
4. **Go live.** The new version, server and files together, replaces the old one at the same link.

If the server doesn't start, nothing changes: the live version keeps serving, and the deploy fails
with `server_failed_to_start` and the first lines of the server's log.

**A secret not set yet holds the version back, not the deploy.** The files upload and the version
waits; the deploy names the secrets it needs. Set them, and the version goes live as soon as the
last one is set, with no second deploy. This is also how a new site starts: secrets belong to a
site, so the first deploy makes the site and waits, and `fling secrets set` then takes it live:

```text
$ fling deploy . --name workshop-quote
  ✖ Version f12ba1d8273dc664 of "workshop-quote" needs the site secrets SLACK_WEBHOOK_URL, which aren't set. It goes live as soon as they are: set it (fling secrets set workshop-quote NAME); nothing needs publishing again
    Set it: `fling secrets set workshop-quote SLACK_WEBHOOK_URL < file`, or
    `fling secrets set workshop-quote --from .env SLACK_WEBHOOK_URL`. The version goes live as soon as the last is set; there is nothing to deploy again.

$ fling secrets set workshop-quote --from .env SLACK_WEBHOOK_URL
  ✓ SLACK_WEBHOOK_URL set on workshop-quote (from .env; nothing else read)
  Version f12ba1d8273dc664 is live now: https://workshop-quote.<sites domain>/
```

If that start fails instead, `fling secrets set` prints the failure and the server's log and exits
non-zero. The version keeps waiting: if a secret was wrong, set it again (or remove one) and the
version is tried again; if the code was wrong, fix it and deploy again: the new version replaces the
waiting one, and goes live at once if its secrets are set.

**A server on a public site asks first.** Anyone can call a public site's `/api/*` directly,
without the page, and use its secrets through it. The CLI asks you to confirm, on `fling deploy`
and on `fling access … --public` or `fling visibility … public` for a site with a server; `--yes`
confirms in scripts, and without a terminal the CLI refuses rather than guess.

### Pull a site with a server

`fling pull` (and `fling_pull`) of a version with a server, by someone who may read its versions
(its owners, publishers and admins), brings down its files with the built bundle, `_fling/server.mjs`, and writes the version's `fling.json` beside them: the secrets and
health path its deploy declared, with no `"server"` entry, since there is no source to bundle.
Deploying the pulled folder publishes that bundle as it is, with the same secrets declared.

```text
$ fling pull workshop-quote
  ✓ Pulled workshop-quote into workshop-quote (5 files, 467 KB, version f12ba1d8273dc664)
  Its server's config is in fling.json. _fling/server.mjs is the server's built bundle, not its source: the folder deploys again as it is, but the server is changed from its source (server.ts and the rest, in the author's own repository), which Fling never stores.
```

**The folder holds the bundle, never the source.** Fling stores only what was published:
`server.ts`, `server/` and the rest stay in the author's own repository. Change the pages in a
pulled folder; change the server where its source lives, and deploy from there.

**Publishing on a base keeps the base's server config.** A publish on the version pulled (`fling
deploy` of the pulled folder, or `fling_read_files` then `fling_publish` with `base`) whose
`_fling/server.mjs` is the base's byte for byte, and that sends no `fling.json`, keeps the secrets
and health path the base version declared. A publish that sends one (`fling.json` in the folder or
among the files, or `siteServer`) uses that one. `fling_read_files` returns the config as `server`
in its result; it is not one of the files.

**A viewer's pull leaves the server out.** Anyone else who can open the site may pull it, and gets
the files a visitor sees: no `_fling/server.mjs` and no `server` config, from `fling pull`,
`fling_pull` and `fling_read_files` alike. The bundle holds whatever its source inlined from
`server/`, which the site's visitors must never see.

## Logs: fling logs

```sh
fling logs workshop-quote               # the last hour
fling logs workshop-quote --since 1d
fling logs workshop-quote --follow      # new lines every 2 seconds
```

```text
06:12:03  POST /api/request  200  412 ms  v_3f9a2c71  version 5024258572153ca0
06:12:03  workshop requested v_3f9a2c71 11546
```

Fling writes one line per request (method, path, status, duration, viewer id, version), and your
server's `console.log` and `console.error` lines appear beside them. Logs are kept for 7 days.
The site's owners and publishers read them, from the CLI, `fling_logs` on either MCP server, or the
Logs section of the site page's Server tab (the last hour, with Refresh and Follow). Admins read
them from the site page too.

**Log the viewer id, not the email.** Everyone who publishes the site can read its logs. The id
(`v_3f9a2c71`) is the same for one person on one site, so you can follow a user through the log,
and different on every other site, so nobody can join two sites' logs. An admin can resolve an id
to a person when there's a reason, by clicking it in the site page's Logs section, and that
lookup is audited (`viewer.resolved`).

## From an agent

### Claude Code, Claude Desktop and the local MCP

The local MCP server runs on your computer, so it does everything the CLI does: `fling_deploy`
bundles the server, `fling_dev` runs the folder locally, and `fling_logs` reads the log. The
Claude Desktop extension ships without esbuild, so there a server with npm dependencies asks for
the CLI ("Bundling a site server needs the Fling CLI"), and a dependency-free
`_fling/server.mjs` publishes as it is. Ask:

- "Add a server to this site that proxies the Anthropic API with a key I'll set as a secret, and
  run it with fling dev."
- "Deploy it to my-site for the design group, then show me its logs."

`fling_dev` starts `fling dev` for a folder and answers with its address; calling it again with
the same folder rebuilds and returns what the server printed and the requests it took, and
`stop: true` stops it. The agent then tries the routes with `curl` and deploys.

The agent can't set a secret's value for you, and shouldn't: no tool takes one, so values never
pass through the conversation. When a deploy answers `secrets_missing`, the agent tells you which
to set; set them with `fling secrets set` or on the site page, and the waiting version goes live.

### Claude on the web and other remote clients

A remote client can't run esbuild, so over the remote MCP connector (`https://<your Fling>/mcp`)
`fling_publish` takes a server that is already one file: `_fling/server.mjs`, importing only
`node:*` and `@nearform/fling/server`. A bare import such as `hono` is refused with
`server_not_bundled`.

1. Call `fling_server_template`. It returns a dependency-free `_fling/server.mjs` (a small router
   with a `/api/health` route) and the matching `fling.json`, like
   [the remote MCP example](#e-a-dependency-free-server-for-the-remote-mcp).
2. Write the routes the site needs into it, without npm packages.
3. Call `fling_publish` with `index.html`, `_fling/server.mjs`, `fling.json` and the other files
   (or pass the `fling.json` object as `siteServer` instead of the file). `fling.json` is never
   published as a file.
4. If the site is public, the first call answers with a `public_server` hint instead of
   publishing. Tell the user that anyone can call the site's `/api/*` and use its secrets through
   it, ask whether to go ahead, and if they agree repeat the call with
   `confirmPublicServer: true`.
5. If it answers `server_failed_to_start`, read the log lines it returns, fix the server and
   publish again.

For anything with dependencies, use the CLI or the local MCP.

## Access, the viewer and caching

**The server is behind the site's access.** A request to `/api/*` passes every check a page does
before the server sees it. On a members-only or restricted site, a visitor who isn't signed in is
sent to sign in (a 302), exactly as for a page; a private site's API is private with no work from
you.

**The viewer.** Fling tells the server who is calling in one request header, set from the
visitor's sign-in:

```http
x-fling-viewer: {"id":"v_3f9a2c71","email":"ada@example.com","guest":false}
```

- `id` is the **viewer id**: stable for this person on this site, different on every other.
- `guest` is true for someone invited from outside the organisation as a reviewer.
- The header is absent (the viewer is null) on a public site and through a share link: a server
  reached through a share link runs, without a viewer. If an endpoint spends money or acts on
  someone's behalf, refuse it when the viewer is null.
- Fling drops the browser's cookies and any `x-fling-viewer` the browser sent, so neither can be
  forged and the server never sees a credential.

**Only same-origin writes.** Every site shares the sites domain, so to a browser one Fling site is
"same-site" as another. To stop another site's page posting to yours as the visitor, any method
but GET, HEAD and OPTIONS needs `Sec-Fetch-Site: same-origin` or the site's own `Origin`, else
403 `cross_origin`. Your own page's `fetch('/api/…')` always passes, and so do `curl` and other
servers, which send neither header and carry no browser cookies. Opting in to cross-origin calls
isn't available yet.

**Methods.** `/api/*` takes any method. Everywhere else on the site is GET and HEAD only, so a form
must post to `/api/…`; `POST /contact` is a 405.

**Caching.** Every `/api/*` request reaches your server: Fling never caches its answers at the
edge, since one member's answer must never reach another. Your `Cache-Control` goes to the browser
as you set it, except that on a site that isn't public `public` becomes `private`. Without one,
Fling sends `private, no-store`.

**Reviews.** The review page frames the site as it is, so reviewers are real viewers and the
server sees them. While the live version has a server, the review page says so above the frame:
what reviewers see may differ, and actions they take are real. If a button posts to Slack, it
posts during a review too.

## Examples

Each folder under [`examples/site-servers/`](../examples/site-servers/) is a complete site. To try
one:

```sh
cd examples/site-servers/workshop-quote
npm install                    # where there is a package.json
fling dev --as ada@example.com
```

### a. The workshop quote: Hono, zod, a Slack webhook and a health check

[`examples/site-servers/workshop-quote/`](../examples/site-servers/workshop-quote/): a page that
prices a workshop and lets a signed-in member ask the team to book it. The rates stay on the
server, the page only sees the answer, and the request goes to Slack with the webhook URL held as a
site secret. Needs `serversEgress` (`SERVERS_EGRESS=open`) for the Slack call.

`server.ts`:

```ts
// The site's server. Fling runs it for /api/* and nothing else; every other path is the
// static files. Bundled by `fling deploy` into _fling/server.mjs with hono and zod inside it.
import { Hono } from 'hono'
import { z } from 'zod'

/** Who Fling says is calling: from the visitor's sign-in, never from the browser. */
type Viewer = { id: string; email: string; guest: boolean } | null
const viewerOf = (header: string | undefined): Viewer => (header ? JSON.parse(header) : null)

const app = new Hono().basePath('/api')

// GET /api/health: what Fling's start probe calls (fling.json "health") before this version
// goes live. It checks the server's own needs, not Fling's: here, that the webhook URL is
// usable. It never posts to Slack.
app.get('/health', c => {
  const url = process.env.SLACK_WEBHOOK_URL ?? ''
  if (!url.startsWith('https://hooks.slack.com/')) {
    return c.json({ ok: false, problem: 'SLACK_WEBHOOK_URL' }, 503)
  }
  return c.json({ ok: true })
})

// GET /api/me: who is looking (null on a public site or through a share link).
app.get('/me', c => c.json(viewerOf(c.req.header('x-fling-viewer')) ?? { email: null }))

const Quote = z.object({
  people: z.number().int().min(1).max(200),
  days: z.number().int().min(1).max(10),
  format: z.enum(['remote', 'onsite']),
})
type Quote = z.infer<typeof Quote>
const INVALID = 'People 1–200, days 1–10, remote or on site.'

// Rates live in the server, not the page: visitors see a price, never the price list.
const DAY_RATE = 4_000
const PER_PERSON_PER_DAY = 85
const ONSITE_UPLIFT = 0.15

function price({ people, days, format }: Quote) {
  const base = DAY_RATE * days
  const seats = PER_PERSON_PER_DAY * people * days
  const uplift = format === 'onsite' ? Math.round((base + seats) * ONSITE_UPLIFT) : 0
  const breakdown = [`£${base} facilitation`, `£${seats} materials`]
  if (uplift) breakdown.push(`£${uplift} on site`)
  return { total: base + seats + uplift, breakdown }
}

// POST /api/quote: a validated price with its working.
app.post('/quote', async c => {
  const input = Quote.safeParse(await c.req.json().catch(() => null))
  if (!input.success) return c.json({ error: INVALID }, 400)
  return c.json(price(input.data))
})

// POST /api/request: sends the quote to the team's Slack channel. Uses the network and the
// SLACK_WEBHOOK_URL site secret (declared in fling.json, set with `fling secrets set`).
app.post('/request', async c => {
  const viewer = viewerOf(c.req.header('x-fling-viewer'))
  if (!viewer) return c.json({ error: 'Sign in to request a workshop.' }, 401)
  const input = Quote.safeParse(await c.req.json().catch(() => null))
  if (!input.success) return c.json({ error: INVALID }, 400)
  const { people, days, format } = input.data
  const { total } = price(input.data)

  const res = await fetch(process.env.SLACK_WEBHOOK_URL as string, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: `${viewer.email} asked for a ${days}-day ${format} workshop for ${people}: £${total}`,
    }),
  })
  if (!res.ok) {
    console.error('Slack answered', res.status)
    return c.json({ error: 'Could not send the request. Try again in a minute.' }, 502)
  }
  // The viewer id, not the email: logs are read by everyone who publishes the site.
  console.log('workshop requested', viewer.id, total)
  return c.json({ sent: true, total })
})

app.notFound(c => c.json({ error: 'No such endpoint' }, 404))

export default app
```

`fling.json` declares the secret and the health check; `package.json` lists `hono` and `zod` as
dependencies and `@nearform/fling` and `@types/node` as dev dependencies. The page
([`index.html`](../examples/site-servers/workshop-quote/index.html),
[`app.js`](../examples/site-servers/workshop-quote/app.js)) calls `/api/me`, `/api/quote` and
`/api/request` with plain `fetch`, on the same origin, so there is no CORS to set up.

Run it:

```sh
cd examples/site-servers/workshop-quote
npm install
echo 'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/…' >> .env
fling dev --as ada@example.com
```

```text
  serving workshop-quote/ at http://localhost:47180  (server: server.ts, rebuilt on save)
  viewer: ada@example.com (v_3f9a2c71) · secrets: SLACK_WEBHOOK_URL (from .env)
```

Publish it: the first deploy waits for the secret, and setting it takes the version live.

```sh
fling deploy . --name workshop-quote --access members
fling secrets set workshop-quote --from .env SLACK_WEBHOOK_URL
```

What visitors get, signed in as a member:

```text
GET  /api/health        → 200 {"ok":true}
GET  /api/me            → 200 {"id":"v_3f9a2c71","email":"ada@example.com","guest":false}
POST /api/quote         {"people":12,"days":2,"format":"onsite"}
                        → 200 {"total":11546,"breakdown":["£8000 facilitation","£2040 materials","£1506 on site"]}
POST /api/request       {"people":12,"days":2,"format":"onsite"}
                        → 200 {"sent":true,"total":11546}
POST /api/quote         {"people":0,"days":2,"format":"remote"}
                        → 400 {"error":"People 1–200, days 1–10, remote or on site."}
GET  /api/nope          → 404 {"error":"No such endpoint"}
GET  /_fling/server.mjs → 404
```

### b. The same /api/me as a plain node:http server

[`examples/site-servers/node-http/`](../examples/site-servers/node-http/): no framework, no
dependencies, no `package.json`, nothing to install. It reads the viewer from the header itself.

`server.js`:

```js
// A site server in the plain Node style: no framework, no dependencies, nothing to install.
// Fling runs it for /api/* and sets PORT; the viewer arrives in the x-fling-viewer header,
// set by Fling from the visitor's sign-in (anything the browser sent under that name is dropped).
import { createServer } from 'node:http'

function viewerOf(req) {
  const header = req.headers['x-fling-viewer']
  return typeof header === 'string' ? JSON.parse(header) : null
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && pathname === '/api/health') return send(res, 200, { ok: true })
  if (req.method === 'GET' && pathname === '/api/me') {
    return send(res, 200, viewerOf(req) ?? { email: null })
  }
  send(res, 404, { error: 'No such endpoint' })
})

// Fling sets PORT on every platform; the fallback is for running it with plain `node server.js`.
server.listen(Number(process.env.PORT ?? 8787))
```

```sh
cd examples/site-servers/node-http
fling dev --as ada@example.com
curl -s localhost:47180/api/me    # {"id":"v_…","email":"ada@example.com","guest":false}
```

With the helper installed, `viewer(req)` from `@nearform/fling/server` does the same as
`viewerOf(req)`, for a Node request as for a fetch `Request`.

### c. An LLM proxy that streams the answer

[`examples/site-servers/llm-proxy/`](../examples/site-servers/llm-proxy/): a page posts a question
to `/api/ask`; the server calls the Anthropic Messages API with a key held as a site secret and
streams the answer back as plain text, which the page appends as it arrives. It shows:

- **`secret()`** for the key, which never reaches the page, the published files or the bundle.
- **Egress.** The call needs `serversEgress` (`SERVERS_EGRESS=open`). Without it, `fetch`
  throws and `/api/ask` answers 502 "The server could not reach the model"; the log says why.
- **The 30-second limit.** It covers the whole stream. The server stops the upstream call at 25 s
  so the answer ends with a note instead of being cut off mid-word, and caps `max_tokens`.
- **Refusing a null viewer.** On a public site or through a share link anyone could call
  `/api/ask` directly and spend the key, so it answers 401 unless someone is signed in.
- **A health check that costs nothing**: it checks the key's shape and never calls the API.

`server.ts`:

```ts
// An LLM proxy: the page posts a question to /api/ask, and this server asks Claude with the
// site's ANTHROPIC_API_KEY, streaming the answer back as plain text. The key is a site secret,
// so it never reaches the page, the published files or the bundle.
//
// Needs an instance whose servers may reach the internet (SERVERS_EGRESS=open): with `none`,
// the call to the Messages API throws and /api/ask answers 502.
import { secret, viewer } from '@nearform/fling/server'

const MODEL = 'claude-haiku-5-5'
const MAX_QUESTION = 2_000
// Fling stops every request after 30 s, streams included. Stopping the upstream call a little
// earlier lets the answer end with a note instead of being cut off mid-word.
const UPSTREAM_TIMEOUT_MS = 25_000

const json = (body: unknown, status = 200) => Response.json(body, { status })

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (request.method === 'GET' && pathname === '/api/health') return health()
    if (request.method === 'POST' && pathname === '/api/ask') return ask(request)
    return json({ error: 'No such endpoint' }, 404)
  },
}

// GET /api/health: the start probe's check. It looks at the key's shape and never calls the
// API, so a publish doesn't spend tokens.
function health() {
  try {
    if (!secret('ANTHROPIC_API_KEY').startsWith('sk-ant-')) throw new Error('malformed')
    return json({ ok: true })
  } catch {
    return json({ ok: false, problem: 'ANTHROPIC_API_KEY' }, 503)
  }
}

async function ask(request: Request) {
  // Only signed-in viewers spend the key. On a public site or through a share link the viewer
  // is null, so anyone who can open the page could otherwise call /api/ask directly.
  const who = viewer(request)
  if (!who) return json({ error: 'Sign in to ask.' }, 401)

  const body = await request.json().catch(() => null)
  const question = typeof body?.question === 'string' ? body.question.trim() : ''
  if (!question || question.length > MAX_QUESTION) {
    return json({ error: `Ask a question of 1 to ${MAX_QUESTION} characters.` }, 400)
  }

  let upstream: Response
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': secret('ANTHROPIC_API_KEY'),
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        stream: true,
        system: 'Answer briefly and plainly, in British English.',
        messages: [{ role: 'user', content: question }],
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (error) {
    // With SERVERS_EGRESS=none this is where it fails: the server has no outbound network.
    console.error('Messages API unreachable', String(error))
    return json({ error: 'The server could not reach the model.' }, 502)
  }
  if (!upstream.ok || !upstream.body) {
    console.error('Messages API answered', upstream.status, await upstream.text())
    return json({ error: 'The model did not answer. Try again in a minute.' }, 502)
  }

  // The viewer id, not the email: logs are read by everyone who publishes the site.
  console.log('ask', who.id, question.length)
  return new Response(answerText(upstream.body), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** The Messages API's server-sent events, reduced to the text of the answer. */
function answerText(events: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = events.pipeThrough(new TextDecoderStream()).getReader()
  const encoder = new TextEncoder()
  let pending = ''
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) return controller.close()
        const lines = (pending + value).split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) {
          const text = textOf(line)
          if (text) controller.enqueue(encoder.encode(text))
        }
      } catch (error) {
        console.error('answer stream stopped', String(error))
        controller.enqueue(encoder.encode('\n\n[Cut off: the answer took too long.]'))
        controller.close()
      }
    },
    cancel() {
      reader.cancel()
    },
  })
}

function textOf(line: string): string | undefined {
  if (!line.startsWith('data: ')) return undefined
  const event = JSON.parse(line.slice(6))
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
    return event.delta.text
  }
  if (event.type === 'error') return `\n\n[The model stopped: ${event.error?.message}]`
  return undefined
}
```

The page reads the stream as it arrives
([`index.html`](../examples/site-servers/llm-proxy/index.html)):

```js
const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  answer.textContent += value
}
```

Run and publish it:

```sh
cd examples/site-servers/llm-proxy
npm install
echo 'ANTHROPIC_API_KEY=sk-ant-…' >> .env.local
fling dev --as ada@example.com
fling deploy . --name ask-claude --access members                # waits for its secret
fling secrets set ask-claude --from .env.local ANTHROPIC_API_KEY  # and goes live
```

### d. Private data and published files

[`examples/site-servers/private-data/`](../examples/site-servers/private-data/): a trade price
calculator. The page shows a public catalogue; the server prices a bulk order using unit costs and
a margin floor that visitors never see.

```text
private-data/
├── index.html
├── data/products.json   published: the page fetches it, and so can anyone who can open the site
├── server.ts
└── server/costs.json    build input: imported into the bundle, never published
```

- **`import costs from './server/costs.json'`.** esbuild puts it inside the bundle. Everything
  under `server/` stays behind, so `GET /server/costs.json` is a 404. This is the place for data
  visitors mustn't see.
- **`file('data/products.json')`** reads the version's published copy, so the server and the page
  always agree. But a published file is a public file: `GET /data/products.json` serves it to
  anyone who can open the site, whichever way the server reads it. `file()` can't read `_fling/`,
  dotfiles or anything outside the version.

`server.ts`:

```ts
// A trade price calculator. The page shows the public catalogue; the server prices a bulk order
// using costs and a margin floor that visitors never see.
//
// Two ways the server reads data, and what each means:
// - server/costs.json is imported, so esbuild puts it inside the bundle. Everything under
//   server/ is a build input: it is never published, and /server/costs.json is a 404.
// - data/products.json is a published file, read through file(). Anyone who can open the site can
//   also fetch /data/products.json, so it holds only what the page shows anyway.
import { file, viewer } from '@nearform/fling/server'
import costs from './server/costs.json' with { type: 'json' }

type Product = { sku: string; name: string; listPrice: number }

const json = (body: unknown, status = 200) => Response.json(body, { status })

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (request.method === 'GET' && pathname === '/api/health') return json({ ok: true })
    if (request.method === 'POST' && pathname === '/api/offer') return offer(request)
    return json({ error: 'No such endpoint' }, 404)
  },
}

// POST /api/offer {"sku","quantity"}: the price per unit and the total, never the cost.
async function offer(request: Request) {
  const body = await request.json().catch(() => null)
  const quantity = Number(body?.quantity)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000) {
    return json({ error: 'Order 1 to 1,000 units.' }, 400)
  }

  // The catalogue is this version's published file, so the server and the page always agree.
  const catalogue: { products: Product[] } = await (await file('data/products.json')).json()
  const product = catalogue.products.find(p => p.sku === body?.sku)
  const cost = costs.unitCost[product?.sku as keyof typeof costs.unitCost]
  if (!product || cost === undefined) return json({ error: 'No such product.' }, 404)

  const discount = costs.volumeDiscounts.find(d => quantity >= d.from)?.off ?? 0
  const floor = Math.ceil(cost * (1 + costs.marginFloor))
  const unitPrice = Math.max(Math.round(product.listPrice * (1 - discount)), floor)

  console.log('offer', viewer(request)?.id ?? 'anonymous', product.sku, quantity)
  return json({ sku: product.sku, quantity, unitPrice, total: unitPrice * quantity })
}
```

```sh
cd examples/site-servers/private-data
npm install
fling dev
curl -s -X POST localhost:47180/api/offer -H 'content-type: application/json' \
  -d '{"sku":"desk-oak","quantity":25}'      # {"sku":"desk-oak","quantity":25,"unitPrice":589,"total":14725}
curl -s -o /dev/null -w '%{http_code}\n' localhost:47180/server/costs.json    # 404
curl -s localhost:47180/data/products.json   # the public catalogue
```

It needs no outbound network, so it runs on an instance whose `serversEgress` is false.

### e. A dependency-free server for the remote MCP

[`examples/site-servers/remote-mcp/`](../examples/site-servers/remote-mcp/): what
`fling_server_template` gives an agent on a remote client. The server is already in its published
form, `_fling/server.mjs`, importing nothing, so `fling_publish` takes it as it is, and `fling dev`
and `fling deploy` run it too. Grow it by adding a route to the table.

```text
remote-mcp/
├── index.html
├── fling.json          {"health": "/api/health"}
└── _fling/server.mjs
```

`_fling/server.mjs`:

```js
// A site server with no dependencies, already in its published form: the remote MCP's
// fling_publish takes _fling/server.mjs as it is, because it imports nothing but node:* (and
// may import the Fling helper). Fling runs it for /api/*; add a route to the table to grow it.

/** Who Fling says is calling, or null on a public site or through a share link. */
function viewerOf(request) {
  const header = request.headers.get('x-fling-viewer')
  return header ? JSON.parse(header) : null
}

const json = (body, status = 200) => Response.json(body, { status })

const routes = {
  // The start probe calls this (fling.json "health") before the version goes live.
  'GET /api/health': () => json({ ok: true }),
  'GET /api/me': request => json(viewerOf(request) ?? { email: null }),
  // GET /api/time?zone=Europe/London: the time now in a time zone, worked out on the server.
  'GET /api/time': request => {
    const zone = new URL(request.url).searchParams.get('zone') || 'UTC'
    try {
      const time = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short', timeZone: zone })
      return json({ zone, time: time.format(new Date()) })
    } catch {
      return json({ error: `Unknown time zone: ${zone}` }, 400)
    }
  },
}

export default {
  async fetch(request) {
    const route = routes[`${request.method} ${new URL(request.url).pathname}`]
    return route ? route(request) : json({ error: 'No such endpoint' }, 404)
  },
}
```

From Claude on the web, with the Fling connector added, ask: "Make a page that tells me the time
in any time zone, worked out by a site server, and publish it as tz-now for everyone signed in."
The agent calls `fling_server_template`, adds the `/api/time` route, and calls `fling_publish`
with the three files.

## When it goes wrong

| Error | What it means | What to do |
|---|---|---|
| 403 `servers_not_allowed` | Your Fling doesn't let you publish servers: `SERVERS` is off, or limited to admins or groups you aren't in | Ask an admin. The static files can still be published without `server.ts` |
| 400 `server_not_bundled` | `_fling/server.mjs` imports something other than `node:*` and `@nearform/fling/server`. Usually a remote client published a server with an npm import | Over the remote MCP, start from `fling_server_template` and drop the dependency. Otherwise deploy with the CLI or the local MCP, which bundle it |
| 400 `server_on_path` | A Path publish contains `_fling/`. Servers run only at the site root | Deploy the server to the site itself, without `--path` |
| 409 `path_conflict` | The site has a Path called `api`, which a server would hide; or the site has a server and you tried to make an `api` Path | Rename or remove the `api` Path, or use another folder name |
| 409 `secrets_missing` | A secret named in `fling.json` isn't set on the site. Also on a rollback to a version that needs one | `fling secrets set <site> --from .env NAME` for each name listed. After a deploy, the waiting version goes live when the last is set, with no second deploy; after a rollback, roll back again |
| 422 `server_failed_to_start` | The start probe failed: the server crashed, didn't listen, took more than 10 s, or its health path didn't answer 2xx. Nothing changed for visitors | Read the log lines in the error. Run `fling dev` and call the health path; check the secrets it needs are set and well formed |
| 500 `server_setup_failed` | The platform refused or failed to create, update or put live the server (an SDK error, not one of Fling's refusals). The message says so in words with a `ref`; the log line with that `ref` holds the platform's error | Publish again; an admin searches the API's logs for the `ref` |
| `public_server` (MCP) / a confirmation (CLI) | The site is public, so anyone can call `/api/*` and use its secrets through it | Make sure that's intended. CLI: answer the prompt or pass `--yes`. MCP: ask the user, then repeat with `confirmPublicServer: true` |
| 403 `cross_origin` | A POST (or other write) to `/api/*` came from another site's page | Call `/api/…` from the site's own pages. Cross-origin calls can't be opted in to yet |
| 405 | A method other than GET or HEAD outside `/api/` | Post forms to a path under `/api/` |
| 502 from your own code, "could not reach" in the log | The server's `fetch` to another host failed. On an instance whose `serversEgress` is false, every outbound call does | Check the capability; ask an admin whether servers may reach the internet |
| 503 `server_stopped` on `/api/*` | An admin has stopped this site's server (the site page's Server tab says so) | Ask an admin |
| 504 `server_timeout`, or a stream cut off at 30 s | A request, or a streamed response, ran past the time limit | Do less per request, stop upstream calls earlier, or ask an admin to raise the limit for the site (on AWS at most 120 s) |
| 502 `server_failed` | The server crashed, threw, or isn't running | Read `fling logs`; run it with `fling dev` |
| 429 | More requests than `SERVER_RPS` allows the site (`rate_limited` on Cloudflare) | Slow down, or ask an admin to raise the site's limit |
| 413 `too_large` | A request body over `SERVER_BODY_BYTES` (10 MB), a bundle over 5 MB, or a secret's value over 8 KB | Send less; leave large dependencies out of the bundle; keep data out of secrets |
| 409 `too_many_servers` | The instance already runs `SERVERS_MAX_SITES` site servers | Publish without the server, or ask an admin |
| 409 `too_many_secrets` | The site has 20 secrets already | Remove one first |
| 409 `servers_egress_unavailable`, `servers_quota` (AWS, operators) | `SERVERS_EGRESS=none` without the Terraform `servers.egress` connector; or `SERVERS_MAX_SITES` × `SERVER_ENVIRONMENTS` × 2 vCPU is over the account's Web Functions quota | See the AWS deploy guide's Site servers section |
| 502 `server_cpu_limit` (Cloudflare) | Cloudflare stopped the server for using more CPU time in one request than `SERVER_CPU_MS` allows (1 s by default) | Do less work per request, or move it out of the loop. A loop timed by `Date.now()` never ends on Cloudflare (see [What works](#what-works-what-doesnt-and-the-limits)). An admin can raise the limit for the site |
| 400 `limit_too_high` (admins) | A time per request past what the platform serves: on AWS, 120 s | Set 120 s or less |
| 400 `invalid_secret_name` | A secret name that isn't A-Z, 0-9 and `_`, or one Fling and the platforms keep (`PORT`, `FILES`, `AWS_*`…), set or declared in `fling.json` | Rename it in `fling.json`, the server and the secret |
| 400 `invalid_secret_value` | A secret set to an empty value (one platform's environment can't hold one) | Give it a value, or remove the secret |
| Your 403 or 404 arrives as 300 with `x-fling-status` (AWS) | The function that puts it back isn't published yet: the deploy after servers are turned on publishes it | Ask the operator to deploy |
