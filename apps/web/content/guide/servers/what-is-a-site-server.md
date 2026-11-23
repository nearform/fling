---
title: What a site server is
part: servers
order: 10
summary: A small backend inside a site, run for /api/* at the site's own address.
requires: [servers]
sources: [packages/shared/src/site-server.ts, packages/shared/src/server-template.ts, apps/cli/src/server-build.ts, apps/cli/src/server/**, apps/api/src/servers/index.ts, apps/api/src/policy.ts, apps/api/src/instance.ts, packages/shared/src/mcp-tools.ts]
verified: ee10036
---

A site server is a small backend that ships inside a site. Put a `server.ts` (or `server.js`) next
to your `index.html`, and {{instance:name}} runs it for every request to `/api/…` at the site's own
address, `https://<name>.{{instance:sites}}/api/…`. Everything else is still your files.

The server keeps its keys as [site secrets](/guide/servers/secrets), knows who is calling, and is
published, versioned, rolled back and reviewed with the rest of the site: same link, same access,
same review page.

## When to use one

Use a site server when a page is nearly enough but needs one thing a browser can't do safely:

- **Call a service with a key**: a language model, a payment sandbox, a search index. The key stays
  on the server and the page never sees it.
- **Send something somewhere**: post to a chat webhook, open a ticket, pass a form on.
- **Keep data off the page**: price lists, margins, scoring rules. The page asks for an answer and
  only ever sees the answer.
- **Answer differently for each person**: the server knows who is signed in.

Don't use one for an app that needs a database, background jobs or memory between requests: a
server has no storage, and it can be stopped and started at any time. To collect answers from
reviewers, use a [form](/guide/feedback/forms) instead; it needs no server.

## Who can publish one

{{instance:name}} decides who may publish a server: nobody, its admins, named groups, or every
member (never guests). If you aren't allowed, a publish with a server is refused with `servers_not_allowed`,
and you can still publish the files without it.

It also decides what servers may reach. Where servers may use the internet, one can call another
service; where they may not, every call to another host fails. The Server tab of the site page
says which (**Outbound network**), and so does the result of a publish.

## In your assistant

- "Add a server to this site that calls the Anthropic API with a key I'll set as a secret, and run
  it locally first."
- "Make a page that tells me the time in any time zone, worked out by a site server, and publish it
  as tz-now for everyone signed in."

In Claude Code the assistant writes `server.ts`, runs it with
[`fling dev`](/guide/servers/develop-and-publish#try-it-on-your-computer) and publishes the folder.
Over the [connector](/guide/start/connect), and in the Claude Desktop extension, which can't
bundle, it starts from a small server already in one file, with no dependencies, and adds the
routes the site needs.

## On the command line

A site with a server is a folder like this:

```
my-app/
├── index.html        published
├── app.js            published
├── server.ts         the server: bundled, never published as a file
├── server/           the rest of the server's code and private data: never published
├── fling.json        what the server needs: never published
├── package.json      the server's dependencies: never published
└── .env              your secrets for fling dev: a dotfile, never published
```

`fling.json` names the [site secrets](/guide/servers/secrets) the server needs and, if you like, a
path that must answer before a new version goes live:

```json
{
  "secrets": ["SLACK_WEBHOOK_URL"],
  "health": "/api/health"
}
```

Add `"server": "src/api.ts"` when the server isn't `server.ts` or `server.js` at the top of the
folder.

The server is either a module whose default export has a `fetch(request)` method that returns a
`Response` (as Hono and itty-router give you), or a plain Node server that listens on
`process.env.PORT`. It can use npm packages: `fling deploy` bundles it with everything it imports
into one file. Install the CLI in the folder for its helpers:

```sh
npm install --save-dev {{fact:cli-package}}
```

```ts
import { file, secret, viewer } from '{{fact:cli-package}}/server'

viewer(request)               // who is calling: { id, email, guest }, or null
await file('data/rates.json') // one of this version's published files
secret('OPENAI_KEY')          // a site secret; throws a clear error when it isn't set
```

The helpers are optional: the viewer is also the `x-fling-viewer` request header (JSON), and each
secret is `process.env.NAME`.

Complete examples, from a quote calculator that posts to Slack to a streaming proxy for a language
model, are in the [site servers how-to]({{fact:repo-url}}/blob/main/docs/site-servers.md#examples).

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `servers_not_allowed` | {{instance:name}} doesn't let you publish servers | Ask an admin, or publish the files without `server.ts` and `fling.json` |
| `too_many_servers` | {{instance:name}} already runs as many site servers as it allows | Ask an admin |
| `server_not_bundled` | `_fling/server.mjs` imports an npm package, usually from an assistant over the connector | Drop the import, or publish the folder with the CLI or Claude Code, which bundle it |
| "Bundling a site server needs the Fling CLI" | The Claude Desktop extension can't bundle a server | Install the CLI and run `fling deploy`, or ask for a server already in one file, `_fling/server.mjs` |
| `too_large` | The bundle is over {{fact:server-bundle-max}} | Leave out large dependencies, or read large data from a published file with `file()` |
| `invalid_secret_name` | A secret in `fling.json` isn't `A-Z`, `0-9` and `_`, or is a name the platform keeps (`PORT`, `PATH`, `FILES`, `AWS_*`…) | Rename it in `fling.json`, in the server and as the secret |

## Good to know

- Anything under `server/` is bundled into the server when imported and never published, so it is
  the place for data visitors mustn't see: neither visitors nor people who pull the site (unless
  they own or publish it) get the bundle. Any other file in the folder is published as usual, and
  anyone who can open the site can fetch it, whichever way the server reads it.
- The bundle is part of the version: [rolling back](/guide/publish/versions) rolls the server back
  too.
- Servers run at the site's root only: a [Path](/guide/team-sites/paths) can't have one.
- A server can't run native add-ons, start other processes, write files or use WebSockets.
