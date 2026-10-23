---
name: fling
description: Deploy, host, publish or share a static site, HTML file (including one in Downloads), zip, report, prototype or build folder (dist/, build/, out/) on fling.labs.nearform.com so Nearformers get a stable URL. Use when the user wants to put something online, get a link to a page or app they built, share a static build with colleagues or a client, or manage (list, share, archive, delete, roll back) their Fling sites.
---

# Fling

Fling puts a folder of static files online at a stable URL:
`https://<name>.fling.labs.nearform.com`. Site names are one global namespace — **first come,
first served** across all Nearformers. Sites are **private by default** — only
people signed in with a Nearform Google account can view them. Re-flinging the same name updates
the site in place; identical content is a no-op; older content is restored instantly.

## When to use

- The user asks to deploy / host / publish / share / "put online" something static: a Vite/React/
  Svelte/Astro build, a generated HTML report, a single `index.html`, docs output, a prototype.
- The user asks about their existing Fling sites (list, share link, visibility, archive, delete,
  roll back).

Not for servers or anything needing a backend at runtime — Fling serves files only.

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
3. **Fling the output folder**, not the project root. Prefer the MCP tool:
   `fling_deploy { path: "dist", name?: "my-app", spa?: true, public?: false }`
   (`path` is absolute or relative to the working directory). Without the MCP server, use the CLI
   with `--yes` (it never prompts then): `npx @nearform/fling ./dist --name my-app --yes`.
   For content you wrote in this conversation, use `fling_publish { name, files: [{ path, content,
   encoding? }] }` instead. It passes the files inline.
4. **If the name is taken** (someone else owns it), the tool fails and lists free suggestions
   (the name plus the user's initials, e.g. `my-app-cc`). Ask the user to pick one or give another
   name, then deploy again with `name`. Never silently pick a different name.
5. **Report the URL** the tool returns and whether it is private or public, plus any `warnings`.

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
- Dotfiles, `node_modules` and anything in a `.flingignore` (gitignore syntax) are skipped. Limits:
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
- **Claude Desktop (including Cowork)** gets these tools from the Fling extension. Download
  https://fling.labs.nearform.com/downloads/fling.mcpb, then double-click it, drag it into Claude,
  or go to Settings → Extensions → Advanced settings → Install Extension.

## Not logged in

If a tool says the user is not logged in, call `fling_login`. It opens the user's browser at the
Nearform sign-in page. If they haven't finished after about 30 seconds, it returns "Finish signing in
in your browser, then try again" and keeps waiting in the background for up to 5 minutes. Tell the
user, then retry. Without `fling_login`, ask the user to run this in Claude Code (the `!` runs it in
their shell):

```
! npx @nearform/fling login
```

`fling_whoami` checks the login.

## Sharing and visibility

- `fling_share { name }` returns a public share link (`https://s--<token>.fling.labs.nearform.com`).
  **Anyone with a share link can view the site without signing in** — say so when you hand it over,
  and only create one when the user wants to share outside Nearform.
- `refresh: true` replaces the link (the old one stops working); `revoke: true` removes it.
- `fling_set_visibility { name, visibility: "public" }` makes the main URL public; `"private"`
  puts it back behind Nearform sign-in. Prefer a share link over making a site public.

## Archive vs delete

- `fling_archive { name }` takes a site offline (404) and hides it, but keeps every file and
  version; `unarchive: true` restores it. Prefer this.
- `fling_delete { name, confirm: true }` permanently removes the site and all versions. Only call
  it after the user has explicitly confirmed deleting that site.

## Other tools

- `fling_check_name { name }` or `{ path }` — is a name available / the user's / taken (with
  suggestions)? With `path`, checks the name `fling_deploy` would generate for that file or folder.
- `fling_find_files { query?, limit?, days? }` — recent `.html`/`.zip` files and folders with an
  `index.html` in Downloads, Desktop and Claude output folders (last 14 days by default).
- `fling_list { archived? }` — the user's sites with URL, visibility and share link.
- `fling_info { name }` — one site with its version history.
- `fling_files { name, versionId? }` — the files in the live version (or an earlier one): use it to
  check what was published, e.g. when the user reports a 404 (no root `index.html` → the root 404s).
- `fling_rollback { name, versionId }` — serve an earlier version (ids from `fling_info`).

CLI equivalents: `fling ls`, `fling info <name>`, `fling versions <name>`, `fling files <name>`, `fling share <name>
[--refresh|--revoke]`, `fling visibility <name> private|public`, `fling archive|unarchive <name>`,
`fling rm <name> --yes`, `fling rollback <name> <versionId>` (prefix with `npx @nearform/fling`
if it is not installed globally; add `--json` for machine-readable output).
