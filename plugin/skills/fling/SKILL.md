---
name: fling
description: Deploy, host, publish or share a static site, HTML file (including one in Downloads), zip, report, prototype or build folder (dist/, build/, out/) on the user's Fling server so they get a stable URL. Use when the user wants to put something online, get a link to a page or app they built, share a static build with colleagues or a client, or manage (list, share, archive, delete, roll back) their Fling sites.
---

# Fling

Fling puts a folder of static files online at a stable URL: `https://<name>.<sites domain>` on the
Fling server the user is logged in to (`fling_whoami` shows where sites are served; the tool
descriptions name it too). Site names are one global namespace on that server — **first come,
first served** across everyone who uses it. A new site is **visible only to the user** unless they
say otherwise (or the Fling opens new sites to everyone signed in to it). Re-flinging the same name updates the site in place; identical
content is a no-op; older content is restored instantly.

## When to use

- The user asks to deploy / host / publish / share / "put online" something static: a Vite/React/
  Svelte/Astro build, a generated HTML report, a single `index.html`, docs output, a prototype.
- The user asks about their existing Fling sites (list, share link, visibility, archive, delete,
  roll back).

Not for servers or anything needing a backend at runtime — Fling serves files only.

## Which Fling

The user may be signed in to several Flings (each has its own sites, sign-in and sites domain).
The MCP tools know all of them; every tool that talks to a Fling takes `server` (an address, host
or unique part of it, e.g. `fling.example.com`).

- **One Fling (or none):** leave `server` out; the tools use it.
- **Several:** the instructions and tool descriptions list them by host, marking the current one.
  Settle which Fling this conversation uses **before anything else**: from the user's words ("on
  fling.example.com", "on the Example one") or, if they don't say, by asking them (suggest
  the current one, their usual choice). Say which one you're using, then pass it as `server` on
  every call for the rest of the conversation, reads included. Switch only when the user asks.
  A call without `server` doesn't run: it returns the list of Flings so you can ask.
- `fling_servers` lists the Flings live (the list in the descriptions was read at startup), with
  who is signed in; `fling_servers { use }` makes one current, the same as `fling use`. Only switch
  the current Fling when the user asks: it changes the CLI's default too.
- Results that give URLs end with the Fling they went to; tell the user which one.
- With the CLI instead of the MCP tools, `fling --server <host> …` targets a Fling for one
  command; without it, commands use the current one.

## How to deploy

1. **Build first.** Run the project's build (e.g. `npm run build`) and find the output folder
   (`dist/` for Vite, `build/` for CRA, `out/` for Next export, `_site/` for Eleventy…). A single
   `.html` file, a `.zip` of a site or any other single file (`.pdf`, `.svg`…) can be flung
   directly (see "Files, zips and downloads" below).
2. **Pick the name.** If the user named the site, use that. Otherwise, the first time you fling a
   folder (or whenever you're unsure), call `fling_check_name { path: "dist" }`: it returns the
   name Fling would generate (e.g. `rocketpod-docs`), its URL and whether it is `available`,
   `yours` (deploying updates their existing site) or `taken`. Confirm the name with the user before
   deploying. Re-deploying a site you already flung in this conversation needs no confirmation.
   **Ask who should see a new site**, unless the user already said: only them (`only_me`, the
   usual default), everyone signed in to the Fling (`members`), specific people or teams
   (`people` with `emails`, `groups` with `groups` by slug; both may be given), or anyone
   (`public`, only when asked). Pass it as `access` on the first deploy. A re-deploy never changes
   who can see a site: use `fling_set_access` for that.
3. **Fling the output folder**, not the project root. Prefer the MCP tool:
   `fling_deploy { path: "dist", name?: "my-app", spa?: true, access?: "only_me" }`
   (`path` is absolute or relative to the working directory). Without the MCP server, use the CLI
   with `--yes` (it never prompts then): `fling deploy ./dist --name my-app --access only_me --yes`
   (`--access people --add a@example.com`, `--access groups --group design`). Use `fling` if it is
   installed (`command -v fling`); otherwise prefix with `npx @nearform/fling`, and suggest the user
   installs it once (the Get started page of their Fling shows the command).
   For content you wrote in this conversation, use `fling_publish { name, files: [{ path, content,
   encoding? }] }` instead. It passes the files inline.
4. **If the name is taken** (someone else owns it), the tool fails and lists free suggestions
   (the name plus the user's initials, e.g. `my-app-cc`). Ask the user to pick one or give another
   name, then deploy again with `name`. Never silently pick a different name.
5. **Report the links** the tool returns and who can open the site (a new site's result says so,
   and how to change it), plus any
   `warnings`. When the Fling has comments, the result leads with the review link (`reviewUrl`):
   give it first, as the link to share for feedback (reviewers sign in to the Fling to see the
   site and comment), then the site URL.

Notes:

- **Name**: lowercase letters, digits and single hyphens (max 50); some (`api`, `www`, `fling`…)
  are reserved. Reuse the same name to update a site. Without a name, Fling generates one from the
  project root (nearest `.git`, else `package.json`/`pyproject.toml`/`Cargo.toml`/`go.mod`) plus the
  folders below it, skipping build output (`dist`, `build`, `out`, `public`, `_site`…), monorepo
  containers (`apps`, `packages`, `src`…) and dot-folders: `~/work/rocketpod/docs` →
  `rocketpod-docs`, `~/work/mono/apps/web/dist` → `mono-web`, `~/work/myapp/dist` → `myapp`. It never
  contains the user's name.
- **SPA flag**: set `spa: true` (`--spa`) for client-routed apps (React Router, Vue Router…) so deep
  links serve `index.html` instead of 404.
- **Vite and absolute paths work**: each site has its own subdomain, so `/assets/x.js` resolves —
  no need to change Vite's `base`.
- **Fling never publishes dotfiles, gitignored files, secret files (keys, certs, credentials) or
  files that contain secrets; it stops and tells you which file and line.** There is no override:
  never rename, re-encode or split a file to get past it. Tell the user which file and line, and
  suggest removing the secret (and rotating it if it was shared) or leaving the file out. Skipped
  dotfiles and gitignored files are listed in the result (`skipped`).
- `node_modules` and anything in a `.flingignore` (gitignore syntax) are skipped too. Limits:
  25 MB per file, 100 MB per deploy.
- **No `index.html` at the root, but HTML pages.** `fling_deploy` and `fling_publish` don't deploy.
  They report the pages. Ask the user whether to generate an index page that links them (retry with
  `listHtml: true`) or deploy without one (`listHtml: false`; the root URL 404s but the pages still
  work). If you might have flung the wrong folder (for example the project root instead of
  `dist/`), say so.
- If the result's `warnings` say there is no `index.html` at the root, the URL will 404. Tell the
  user.
- In a terminal, the CLI asks the user to confirm the generated name
  (`Use "x"? [Y/n or type another name]`). With no `index.html` it offers `[L]ist the HTML pages /
  [f]ling anyway / [a]bort`; `--list-html` / `--no-list-html` decide up front. `--yes`, or no
  terminal, skips the prompts. Fling then generates the listing when there are HTML pages, and a
  taken name is an error.

## Files, zips and downloads

- **What `fling_deploy` (and the CLI) accept:**
  - a folder;
  - a single `.html`/`.htm` file, served as `index.html`;
  - a `.zip`, extracted with a single top-level folder unwrapped and `__MACOSX`/dotfiles skipped;
  - any other file, served next to a generated page that shows or links it.
- **Default names** for a file come from the file name: `Pitch Deck (1).html` → `pitch-deck`.
- **Just the file name works.** If the path doesn't exist, it is looked up, newest first, in the
  working folder, Downloads, Desktop, `~/Documents/Claude`, `~/Claude` and Claude Desktop/Cowork
  output folders. The result says where it was found. `fling_find_files { query? }` lists recent
  candidates.
- **Never pass paths from your own sandbox** (`/mnt/user-data/outputs/…`, `/sessions/…`), and never
  curl or upload from it. That machine can't reach Fling. Publish what you wrote with
  `fling_publish`. For a file the user downloaded, use its name with `fling_deploy`.
- **Claude Desktop (including Cowork)** gets these tools from the Fling extension. Download it from
  the Get started page of any of the user's Flings (`https://<their Fling>/downloads/fling.mcpb`),
  then double-click it, drag it into Claude, or go to Settings → Extensions → Advanced settings →
  Install Extension. One extension serves every Fling: installing from another Fling updates it
  and adds that Fling.

## Not logged in

If a tool says the user is not logged in, call `fling_login`. It opens the user's browser at their
Fling's sign-in page. If they haven't finished after about 30 seconds, it returns "Finish signing in
in your browser, then try again" and keeps waiting in the background for up to 5 minutes. Tell the
user, then retry. Without `fling_login`, ask the user to run this in Claude Code (the `!` runs it in
their shell):

```
! fling login <url>
```

`<url>` is the address of their Fling (ask them if you don't know it); after the first login,
`fling login` alone signs in to the same one. If a tool says no Fling server is set up, this is
what to do. (If `fling` isn't installed, use `! npx @nearform/fling login <url>`.)

To sign in to another Fling, or one not set up yet, call `fling_login { server: "<its address>" }`.
It is remembered, and becomes the current one only if none is.

`fling_whoami` checks the login.

## Who can see a site

- Five access levels, narrowest first: `only_me`, `groups`, `people`, `members`, `public`.
  `fling_set_access { name, access, emails?, groups? }` sets any of them (`groups` and `people`
  take the whole list of addresses and group slugs, and may name both). Only change it when the
  user asks. `fling_info` shows who can open a site.

- `fling_share { name }` returns a public share link (`https://s--<token>.<sites domain>`).
  **Anyone with a share link can view the site without signing in** — say so when you hand it over,
  and only create one when the user wants to share with people who can't sign in.
- `refresh: true` replaces the link (the old one stops working); `revoke: true` removes it.
- `fling_set_visibility { name, visibility: "public" }` makes the site itself public (anyone can open it;
  its review page and comments still need sign-in); `"private"` gives it back the access it had
  (only the user, everyone signed in, or its list). Prefer a share link over making a site public.
- `fling_set_audience { name, add?, remove?, set?, clear? }` edits that list of people
  (addresses that can sign in to the Fling; where the Fling invites people from outside, as its tool
  descriptions say, an outside address is invited as a guest, a reviewer who signs in by emailed
  link and sees only what is shared with them, and `too_many_invites` means the day's invitations
  are spent: nothing changed) and limits the site to them; `clear: true` opens it to
  everyone signed in. The owner always sees it. It only applies while the site is private, a share link still
  opens it to anyone (say so if one exists), and someone removed can keep seeing it for up to 5
  minutes. `fling_info` shows who can open a site.
- `addGroups`, `removeGroups` and `setGroups` on `fling_set_audience` do the same for **groups**
  (named lists of people, by slug). `fling_groups` lists them (`mine: true`: the user's own;
  `members: [...]`: only the groups of exactly those people) and `fling_group_show { slug }` shows
  who is in one. Before making a group, or when an audience lists several people, call
  `fling_groups { members }` and offer an existing group instead. Anyone can use any group, but only its owner can
  change it: `fling_group_create { slug, name, members? }`, `fling_group_members { slug, add?,
  remove? }`, `fling_group_rename`, `fling_group_delete` (needs `confirm: true`;
  sites keep their restriction and anyone it let in loses access, so confirm with the user). A site
  limited to a deleted group alone shows "a deleted group (#<id>)" and is its owner's only until
  they add people or groups.

## Archive vs delete

- `fling_archive { name }` takes a site offline (404) and hides it, but keeps every file and
  version; `unarchive: true` restores it. Prefer this.
- `fling_delete { name, confirm: true }` permanently removes the site and all versions. Only call
  it after the user has explicitly confirmed deleting that site.

## Comments

People review a site on its review page (`<their Fling>/review/<name>`) and leave comments on its
pages. When the Fling has comments, these tools exist:

- `fling_comments_list { name, path?, includeResolved? }` — open threads with replies, the page and
  the version each was written on. Use it to act on feedback.
- `fling_comment_resolve { name, id, reopen? }` — after fixing what a thread asks for (and
  republishing), resolve it.
- `fling_comment_add { name, body, path?, replyTo? }` and `fling_comment_delete { name, id }` —
  only when the user asks: comments are signed with their name.

## Notifications

When the Fling has notifications (it emails people when a site is shared with them, they are added
to a group, or someone comments on their site or replies in their thread), these tools exist:

- `fling_notifications` — each event (by key, e.g. `comment.created`) with, per channel (`email`),
  whether it is on or off, `(yours)` where the user chose it, and whether everything is muted. Use
  it when the user asks why they get (or don't get) emails.
- `fling_notifications_set { muted?, cells? }` — `muted: true` stops everything (`false` turns it
  back on, keeping their choices); `cells: [{ event, channel, value }]` turns one event on or off,
  or back to the default (`value: "default"`). Only change what the user asked for.

What was sent to them is on their settings page (`<their Fling>/settings/notifications`) and in
`fling notifications sent`.

## Other tools

- `fling_check_name { name }` or `{ path }` — is a name available / the user's / taken (with
  suggestions)? With `path`, checks the name `fling_deploy` would generate for that file or folder.
- `fling_find_files { query?, limit?, days? }` — recent `.html`/`.zip` files and folders with an
  `index.html` in Downloads, Desktop and Claude output folders (last 14 days by default).
- `fling_list { archived?, sort? }` — the user's sites with URL, visibility and share link, last
  updated first; `sort: "created"` (newest first) or `"name"` (A–Z) for another order.
  `shared: true` lists instead the restricted sites other people have shared with the user (by
  address or through a group), with owner and review link: use it when the user asks what has
  been shared with them. Only the owner manages those sites (and the instance's admins, from the
  web app).
- `fling_info { name }` — one site with its version history. An admin reads anyone's site this
  way; changing someone else's site takes the web app, so say so rather than retrying.
- `fling_files { name, versionId? }` — the files in the live version (or an earlier one): use it to
  check what was published, e.g. when the user reports a 404 (no root `index.html` → the root 404s).
- `fling_rollback { name, versionId }` — serve an earlier version (ids from `fling_info`).

CLI equivalents: `fling ls` (`--shared`), `fling info <name>`, `fling versions <name>`, `fling files <name>`, `fling share <name>
[--refresh|--revoke]`, `fling visibility <name> private|public`, `fling access <name> [--add|--remove <emails>|--group|--remove-group <slugs>|--clear]`, `fling groups [list|show|create|add|remove|rename|delete]`, `fling notifications [set <event> <channel> on|off|default|mute|unmute|sent]`, `fling archive|unarchive <name>`,
`fling rm <name> --yes`, `fling rollback <name> <versionId>` (prefix with `npx @nearform/fling`
if it is not installed globally; add `--json` for machine-readable output).
