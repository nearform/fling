---
title: Try it and publish it
part: servers
order: 20
summary: Run a site and its server on your computer with fling dev, then publish both together.
requires: [servers]
sources: [apps/cli/src/commands/dev.ts, apps/cli/src/dev-server.ts, apps/cli/src/dotenv.ts, apps/cli/src/server-build.ts, apps/cli/src/commands/deploy.ts, apps/cli/src/site-server.ts, apps/cli/src/mcp.ts, apps/api/src/servers/index.ts, apps/api/src/mcp/publish.ts, packages/shared/src/mcp-tools.ts, packages/shared/src/server-template.ts]
verified: 1f60f9d
---

`fling dev` runs a folder on your computer the way its site will be served, with its server beside
it. When it works, `fling deploy` publishes the files and the server together, and the new version
goes live only once its server has started.

## In your assistant

- "Run this site with fling dev and try the quote endpoint."
- "Deploy it as my-app for the design group, then show me its logs."
- "The publish said `server_failed_to_start`: fix it and publish again."

In Claude Code the assistant runs the folder locally (`fling_dev`), tries the routes, and
publishes with `fling_deploy`, which bundles the server with its npm packages. The Claude Desktop
extension can't bundle: on its own it publishes a server that is already one file,
`_fling/server.mjs` (as over the connector, below), and a `server.ts` is published with
`fling deploy` from the [CLI](/guide/start/cli). When a publish fails to start, the assistant gets the server's
first log lines and can fix it in the same turn.

Over the [connector](/guide/start/connect) (Claude on the web, ChatGPT and other remote clients)
nothing can be bundled, so the assistant starts from a server with no dependencies
(`fling_server_template`), writes the routes into it, and publishes it as `_fling/server.mjs` with
the pages and `fling.json`.

## On the command line

### Try it on your computer

```sh
fling dev                                  # this folder
fling dev ./my-app --as ana@example.com    # requests arrive as a signed-in viewer
fling dev --as ana@example.com --guest     # … as a guest
```

It serves the folder at `http://localhost:47180` (another free port if that one is taken, or the
one you give with `--port`), and rebuilds
the server when you save. `--spa` serves `index.html` for unknown paths, as a deploy with `--spa`
does.

```
serving my-app/ at http://localhost:47180  (server: server.ts, rebuilt on save)
viewer: ana@example.com (v_3f9a2c71) · secrets: SLACK_WEBHOOK_URL (from .env)
```

- **The files are served as they will be**: the 404 page, dotfiles hidden, `/api/…` to the server,
  and Markdown rendered as a published site renders it (`?raw=1` for the source, a README as a
  folder's home page when it has no `index.html`).
- **Secrets come from `.env`**, with `.env.local` overriding it. Only the secrets `fling.json`
  names reach the server; anything else in those files stays out. A named secret in neither file is
  a warning.
- **Without `--as`** nobody is signed in, as on a public site.

Each request and everything the server prints appears in the terminal. Try it with the page or with
`curl`:

```sh
curl -s localhost:47180/api/health
```

`fling dev` runs the server in Node on your computer, which allows a little more than a published
server gets. Bundling is the same as at deploy, so an import that won't work once published fails
here first.

### Publish it

```sh
fling deploy . --name my-app --access members
```

```
bundling server.ts → _fling/server.mjs (465 KB, 100 KB gzipped)
starting server… GET /api/health answered in 1.2 s
✓ Deployed my-app (4 files, 467 KB; uploaded 4, version f12ba1d8273dc664)
```

The result adds a line about the server: where it answers, who can call it, whether it may reach
the internet and which secrets it uses.

1. The CLI bundles the server with its dependencies. `fling.json`, `package.json`, the lockfile,
   the entry and `server/` stay behind.
2. {{instance:name}} checks the bundle and that you may publish servers, and the files upload.
3. It checks that every secret in `fling.json` is set, starts the new version's server and asks
   its `health` path, which must answer with a 2xx. Without a `health` path it asks `/api/` and
   any answer will do.
4. Only then does the new version, server and files together, replace the live one.

If the server doesn't start, nothing changes for visitors: the live version keeps serving.

**A secret that isn't set holds the version back, not the publish.** The files upload and the
version waits; the result names the secrets it needs. Set them (see
[Site secrets](/guide/servers/secrets)) and the version goes live as soon as the last one is set,
with nothing to publish again.

**A public site with a server asks first**, because anyone could call its `/api/…` without the
page and use its secrets through it. `fling deploy`, `fling access --public` and
`fling visibility … public` ask you to confirm; `--yes` confirms in scripts.

<!-- requires: pull -->
### Change a site that has a server

`fling pull` of a site with a server (see [Change a published site](/guide/publish/change-a-site)),
by one of its owners or publishers, brings down the built bundle, `_fling/server.mjs`, and a `fling.json` with the secrets and health
path it was published with. Deploying that folder publishes the same server, with the same secrets.
It is the bundle, not the source: {{instance:name}} never stores `server.ts` or `server/`. Change
the pages in the pulled folder; change the server in its own folder, wherever you keep its source,
and deploy from there. Anyone else who can open the site pulls only its pages: the bundle, with
whatever it took from `server/`, stays with the people who publish it.

Publishing on what is live keeps the server's `fling.json` as it was, so long as the bundle is the
same: an assistant that reads the site's files and publishes a change to a page needn't send it.
Send a `fling.json` to change it.
<!-- /requires -->

## In the web app

The site page's **Server** tab shows the server once a version with one is live: where it answers,
whether it may reach the internet, its requests in the last hour and its limits. See
[Logs and the Server tab](/guide/servers/logs). Choosing **Public** on the **Access** tab of a site
with a server asks you to confirm too.

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| `server_failed_to_start` | The server crashed, didn't listen, said nothing for {{fact:server-probe-timeout}}, or its `health` path didn't answer 2xx | Read the log lines that come with it. Run `fling dev` and call the health path; check its secrets are set and right |
| `server_setup_failed` | Fling couldn't create or update the server on its platform. The fault is in Fling, not in your site | Publish again in a minute. If it fails again, send your Fling's admin the reference in the message |
| `secrets_missing` | A secret `fling.json` names isn't set. The version waits for it | Set it: the version then goes live by itself |
| `public_server`, or a question | The site is public and the version has a server | Make sure anyone may call it, then confirm (`--yes`) |
| "Could not bundle server.ts" | The bundler couldn't build the server | Fix the file and line it names; try `fling dev` |
| "A Path can't have a server", `server_on_path` | You published a folder with a server as a [Path](/guide/team-sites/paths) | Publish the server to the site itself, without `--path` |
| `path_conflict` | The site has a Path called `api`, where the server would answer | Delete or rename that Path first |

## Good to know

- `fling deploy` never uploads `.env` or `.env.local`: a local file never quietly becomes the
  site's secrets.
- A site server and its secrets go with the site through [rollback](/guide/publish/versions): a
  rollback runs the old code with today's secrets.
