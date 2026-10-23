# @nearform/fling

Fling a folder of static files at [fling.labs.nearform.com](https://fling.labs.nearform.com) and
get a stable link back:

```
https://<name>.fling.labs.nearform.com
```

Site names are one global namespace, first come first served. Sites are private to signed-in Nearformers by default. Share links make them viewable by anyone
who has the link.

## Install

Node 22 or later.

```sh
npm install -g @nearform/fling   # then: fling …
# or run without installing:
npx @nearform/fling …
```

## Log in

```sh
fling login
```

This opens your browser for Nearform Google sign-in and stores an API key in
`~/.fling/config.json` (mode 0600). `fling whoami` shows who you are, and `fling logout` removes the
key. For CI, set `FLING_API_KEY` instead.

## Deploy

```sh
npm run build
fling ./dist                        # name generated from the project, e.g. rocketpod-docs; you confirm it
fling ./dist --name my-app          # → https://my-app.fling.labs.nearform.com
fling ./dist --name my-app --spa    # client-side routing: unknown paths serve index.html
fling ./dist --public               # no sign-in needed to view
fling ./dist --yes                  # never prompt (CI): use the generated name as is
fling                               # deploys the current folder
fling "Pitch Deck.html"             # a single page, served as index.html → pitch-deck
fling site.zip                      # a zip of a site: extracted, a single top folder unwrapped
fling diagram.svg                   # any other file, next to a generated page that shows it
```

What you can fling:

- **A folder**, as is.
- **A single `.html`/`.htm` file**, served as the site's `index.html`.
- **A `.zip`**: extracted (paths that would escape the folder are refused), `__MACOSX/` and dotfiles
  skipped, and a single top-level folder unwrapped.
- **Any other file** (`.pdf`, `.svg`, `.png`, `.md`…), served next to a small generated `index.html`
  that shows it (images, PDF, video, audio) or links to it.

A file's default site name comes from its name, without the extension or a browser's ` (1)`
duplicate suffix: `Pitch Deck (1).html` → `pitch-deck`. Folders use the naming rules below.

**Files by name.** If the path doesn't exist where you are, Fling looks for it by name, newest
first, in Downloads (`FLING_DOWNLOADS_DIR` if set; on Linux your XDG download folder), Desktop,
`~/Documents/Claude`, `~/Claude` and Claude Desktop's output folders, and says where it found it:

```
$ fling Pitch-Deck.html
fling Found in Downloads: /Users/me/Downloads/Pitch-Deck.html
```

- Re-fling to update. Identical content is a no-op, and content you deployed before is restored
  instantly without uploading.
- Dotfiles, `node_modules` and anything listed in a `.flingignore` (gitignore syntax) are skipped.
  Symlinks pointing outside the folder are never followed.
- Limits are 25 MB per file, 100 MB per deploy and 5,000 files.
- Absolute asset paths (`/assets/x.js`) work because each site has its own subdomain.

### Site names

Names use lowercase letters, digits and single hyphens, up to 50 characters, and are first come,
first served across everyone. A few (`api`, `www`, `fling`…) are reserved. If a name belongs to
someone else, Fling suggests free ones with your initials appended (`my-app-cc`, `my-app-cc2`…).

Without `--name`, the name is generated from the folder, never from your user name:

1. Find the project root: the nearest folder (this one or above) containing `.git`, otherwise
   `package.json`, `pyproject.toml`, `Cargo.toml` or `go.mod`. The search stops at your home folder.
2. Use the root's folder name plus the folders from the root down, skipping build output
   (`dist`, `build`, `out`, `output`, `public`, `www`, `_site`, `site`, `html`, `static`, `export`,
   `target`), monorepo containers (`apps`, `packages`, `src`, `sites`, `libs`, `projects`,
   `services`), dot-folders (`.vitepress`, `.next`…) and repeats. A `-static`/`-dist`/`-build`/`-out`
   suffix is trimmed (`storybook-static` → `storybook`).
3. With no project root, use the deepest folder that isn't build output.
4. Too long? Middle parts are dropped, then it is truncated.

| Folder | Name |
|---|---|
| `~/work/rocketpod/docs` | `rocketpod-docs` |
| `~/work/myapp/dist` | `myapp` |
| `~/work/mono/apps/web/dist` | `mono-web` |
| `~/work/mono/packages/ui/storybook-static` | `mono-ui-storybook` |
| `~/Downloads/report/dist` (no project) | `report` |

### Prompts

In a terminal, Fling checks the generated name and asks before deploying:

```
fling Site name: rocketpod-docs → https://rocketpod-docs.fling.labs.nearform.com/  (new)
Use "rocketpod-docs"? [Y/n or type another name]
```

The note says `(new)` or `(updates your existing site)`. If the name is taken it lists suggestions
and offers the first one. Press Enter to accept, type another name to check that one, or `n` to
abort.

If there is no `index.html` at the top it asks:

```
No index.html at the root. [L]ist the HTML pages on a generated index page / [f]ling anyway (the root will 404) / [a]bort
```

**L** (the default, offered when there are `.html` pages) adds a generated `index.html` that links
every HTML page, titled from each page's `<title>`. It is built in memory and uploaded with the
site; your folder is never written to. Without HTML pages the choices are fling anyway or abort
(the default). `--list-html` and `--no-list-html` decide up front.

With `--name` there is no name prompt. With `--yes`, or without a terminal (CI, agents), Fling never
asks: with no `index.html` it generates the listing when there are HTML pages (otherwise it warns),
and a taken name fails (exit 1) with suggestions rather than picking another name — pass `--name`.

## Manage sites

| Command | |
|---|---|
| `fling ls [--archived]` | your sites |
| `fling info <name>` / `fling versions <name>` | details and version history |
| `fling files <name> [versionId]` | the files in the live version (or an earlier one) |
| `fling rollback <name> <versionId>` | serve an earlier version |
| `fling share <name> [--refresh] [--revoke]` | public share link: print or create it, rotate it, or remove it |
| `fling visibility <name> private\|public` | require sign-in, or not |
| `fling archive <name>` / `fling unarchive <name>` | take offline and keep the files, or bring back |
| `fling rm <name> [--yes]` | delete permanently |

Global options: `--json` prints machine-readable output, and `--server <url>` points at another
server. Exit codes are `0` ok, `1` error, `2` not logged in and `3` forbidden.

Environment: `FLING_API_KEY`, `FLING_URL`, `FLING_CONFIG_DIR`, `FLING_DEBUG`, `FLING_DOWNLOADS_DIR`
(where files given by name are looked for first), `FLING_NO_WAIT=1` (after a deploy or a new share
link, don't wait the few seconds it takes to reach every edge).

## Claude Code plugin and MCP

The Fling plugin gives Claude a `fling` skill plus an MCP server (`fling mcp`), so you can say
"fling the dist folder and give me a share link":

```
/plugin marketplace add nearform/fling
/plugin install fling@fling
```

Log in once with `npx @nearform/fling login`. The MCP server reuses that login.

The MCP tools:

- `fling_deploy`: a folder, `.html`, `.zip` or other file on this computer, by path or just its
  name (looked up like the CLI does).
- `fling_publish`: files passed inline, for content Claude wrote in the conversation. It has the same
  definition as the remote connector's tool.
- `fling_find_files`: recent `.html`/`.zip` files and folders with an `index.html` in those folders,
  newest first (last 14 days by default).
- `fling_login`: opens the browser sign-in. If you haven't finished after about 30 seconds it returns
  and keeps waiting in the background for up to 5 minutes.
- `fling_check_name`, `fling_list`, `fling_info`, `fling_share`, `fling_set_visibility`,
  `fling_archive`, `fling_rollback`, `fling_delete` (needs `confirm: true`) and `fling_whoami`.

The MCP server never prompts:

- **Names.** Without a `name`, `fling_deploy` uses the generated name and fails with suggestions if
  it is taken. `fling_check_name` (with a `name`, or a `path` to see its generated name) lets the
  agent confirm a name with you first.
- **No `index.html`.** If there are HTML pages but no `index.html`, `fling_deploy` and
  `fling_publish` don't deploy. They ask the agent to check with you, then retry with
  `listHtml: true` (generate the listing) or `listHtml: false` (deploy anyway).

## Claude Desktop extension

For Claude Desktop (including Cowork), install the one-click extension. It runs the same MCP server
on your computer, so Claude can fling files you downloaded or that Claude Desktop saved, by name,
without uploading anything from Claude's sandbox.

1. Download [fling.mcpb](https://fling.labs.nearform.com/downloads/fling.mcpb).
2. Double-click it, or drag it into Claude Desktop, or go to **Settings → Extensions → Advanced
   settings → Install Extension…** and pick the file.
3. Optional settings: **Fling server** (default `https://fling.labs.nearform.com`) and **Downloads
   folder** (default `~/Downloads`).
4. Ask Claude to "fling Pitch Deck.html from my Downloads". If you're not signed in, Claude calls
   `fling_login` and your browser opens. The extension and the CLI share the login in
   `~/.fling/config.json`.

It needs Node.js 20 or later, which Claude Desktop provides, on macOS or Windows.

Build it with `pnpm --filter @nearform/fling build:mcpb`. That bundles `src/mcp-entry.ts` and every
dependency into one file, then validates and packs `mcpb/manifest.json` into `dist/fling.mcpb`.
CI publishes it at `/downloads/fling.mcpb`.

To use the MCP server in another client, run it over stdio:

```json
{ "command": "npx", "args": ["-y", "@nearform/fling@latest", "mcp"] }
```

## Development

From the repo root:

```sh
pnpm cli --server http://localhost:3001 login   # against `pnpm dev`
pnpm --filter @nearform/fling test
pnpm --filter @nearform/fling build             # → dist/cli.js
```
