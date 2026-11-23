---
title: Logs and the Server tab
part: servers
order: 40
summary: Every request a site's server took and what it printed, kept for a week.
requires: [servers]
sources: [apps/api/src/servers/logs.ts, apps/api/src/servers/api.ts, apps/api/src/policy.ts, apps/cli/src/commands/servers.ts, apps/cli/src/site-server.ts, apps/web/src/components/site/SiteServer.tsx, apps/web/src/components/site/SiteLogs.tsx, apps/web/src/lib/servers.ts, apps/web/src/pages/Site.tsx, packages/shared/src/site-server.ts, packages/shared/src/mcp-tools.ts]
verified: ee10036
---

{{instance:name}} writes a line for every request a site's server takes (method, path, status,
time taken, who asked and which version answered) and keeps what the server prints with
`console.log` and `console.error` beside it, for {{fact:server-log-days}}. A site's owners and
publishers read them, and so can admins in the web app.

## In your assistant

- "Show me my-app's server logs from the last hour."
- "Why is my-app's `/api/quote` failing? Check its logs."

The assistant reads them with `fling_logs`, in Claude Code, Claude Desktop and over the connector.

## On the command line

```sh
fling logs my-app                 # the last hour
fling logs my-app --since 2d      # 15m, 1h, 2d, or a time such as 2026-11-15T06:00:00Z
fling logs my-app --follow        # keep printing new lines, every 2 seconds, until Ctrl-C
```

```
06:12:03  POST /api/request  200  412 ms  v_3f9a2c71  version 5024258572153ca0
06:12:03  workshop requested v_3f9a2c71 11546
```

## In the web app

Open the site from **Sites** and choose its **Server** tab. It has up to three sections:

- **Server**, while the live version has one: the address it answers at, whether it may reach the
  internet (**Outbound network**), its requests and server errors in the last hour, and the
  **Limits** it runs with. Only an admin can change those.
- **Secrets**: see [Site secrets](/guide/servers/secrets).
- **Logs**: the last hour of the log. **Refresh** reads it again, and **Follow** keeps it up to
  date.

## People in the log are viewer ids

A request's line names who asked by **viewer id**, such as `v_3f9a2c71`, not by email address. The
id is the same for one person on one site, so you can follow someone through the log, and
different on every other site, so nobody can match people across two sites' logs. A request with
nobody signed in (a public site, a share link) says **no viewer** in the web app, and `-` on the
command line.

Your server is told the email address too. Log the viewer id instead: everyone who publishes the
site can read its log.

An admin can click a viewer id in the Logs section to see whose it is. The lookup is recorded in
the audit log.

## For admins

On any site's **Server** tab an admin can:

- **Stop…** the server: every request to `/api/…` answers 503 until an admin presses **Start**.
  The pages are still served, and the site's owners can't start it themselves.
- **Limits…**: raise or lower this site's limits. A blank field uses the instance's.

Both are recorded in the audit log.

## When it goes wrong

- **"No site … with a server that you can manage"**: there is no site by that name, or you aren't
  one of its owners or publishers.
- **"No log lines for my-app since 1h"**: nothing reached the server in that time. Try a longer
  `--since`.
- **Invalid `--since`**: use a duration such as `15m`, `1h` or `2d`, or a time.

## Good to know

- Each line names the version that wrote it, so you can tell a rollback's lines from the newer
  version's.
