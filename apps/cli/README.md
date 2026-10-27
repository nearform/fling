# @nearform/fling

Fling a folder of static files at your Fling server and get a stable link back:

```
https://<name>.<your sites domain>
```

Site names are one global namespace per server, first come first served. Sites are private to
people signed in to that Fling by default. Share links make them viewable by anyone who has the
link.

> **Upgrading from 0.2?** The CLI no longer has a built-in server. If you were logged in with 0.2
> it carries on with the server you logged in to. Otherwise (or on a new machine) run
> `fling login <url>` once with your Fling's address. See [CHANGELOG.md](CHANGELOG.md).

## Install

Node 22 or later.

```sh
npm install -g @nearform/fling   # then: fling …
# or run without installing:
npx @nearform/fling …
```

## Set up

```sh
fling setup https://fling.example.com   # your Fling's address; later runs can leave it out
```

This does everything a new machine needs:

1. **Signs you in.** The CLI reads the server's `/.well-known/fling` (its name, where its sites
   live, how people sign in) and remembers it. Your browser opens for sign-in and an API key is
   stored in `~/.fling/config.json` (mode 0600). This is skipped if you're already signed in.
   The server becomes your current one; logins to other Flings are kept.
2. **Adds Fling to Claude Code.** If `claude` is on your PATH, setup installs the Fling plugin
   (skill + MCP server) from the `nearform/fling` marketplace, or updates it if it's already
   installed. `--scope project|local` installs it for this project only (default `user`).
3. **Adds Fling to Claude Desktop.** If Claude Desktop is installed (macOS, Windows), setup
   downloads `fling.mcpb` and opens it, and Claude Desktop asks you to confirm.

On a terminal it asks before steps 2 and 3. With `--yes` it does them without asking.

To sign in only, use `fling login <url>` (the URL is remembered: later `fling login` needs none).
There is no default server: until you log in, commands say to run `fling login <url>`.
`fling whoami` shows who you are and which server is current. For CI, set `FLING_URL` and
`FLING_API_KEY` instead.

### Several Flings

The CLI remembers every Fling you sign in to, each with its own key, and uses the current one.
`fling login <url>` or `fling setup <url>` adds a Fling (or signs in to it again) and makes it
current; the others stay signed in.

```sh
fling use                              # list them: * marks the current one, with its name and your email
fling use other.example.com            # switch: a full address, its host, or the start of it
fling --server other.example.com ls    # one command against another Fling, with its own key
```

`FLING_URL` picks a Fling the same way for every command run with it, and `FLING_API_KEY`
overrides the stored key. `fling logout` removes the current Fling's key and keeps it current (a
bare `fling login` signs in again); `fling logout <url>` signs out of another Fling and forgets
it.

## Deploy

```sh
npm run build
fling deploy ./dist                        # name generated from the project, e.g. rocketpod-docs; you confirm it
fling deploy ./dist --name my-app          # → https://my-app.<your sites domain>
fling deploy ./dist --name my-app --spa    # client-side routing: unknown paths serve index.html
fling deploy ./dist --public               # no sign-in needed to view
fling deploy ./dist --yes                  # never prompt (CI): use the generated name as is
fling deploy                               # deploys the current folder
fling deploy "Pitch Deck.html"             # a single page, served as index.html → pitch-deck
fling deploy site.zip                      # a zip of a site: extracted, a single top folder unwrapped
fling deploy diagram.svg                   # any other file, next to a generated page that shows it
```

`fling <path>` is short for `fling deploy <path>` when the path exists, so `fling ./dist` works.
An existing path wins over a command of the same name. Bare `fling` prints help.

What you can fling:

- **A folder**, as is.
- **A single `.html`/`.htm` file**, served as the site's `index.html`.
- **A `.zip`**: extracted (paths that would escape the folder are refused), `__MACOSX/` and dotfiles
  skipped (dotfiles such as `.env` are listed), and a single top-level folder unwrapped.
- **Any other file** (`.pdf`, `.svg`, `.png`, `.md`…), served next to a small generated `index.html`
  that shows it (images, PDF, video, audio) or links to it.

A file's default site name comes from its name, without the extension or a browser's ` (1)`
duplicate suffix: `Pitch Deck (1).html` → `pitch-deck`. Folders use the naming rules below.

The path must exist where you give it. The CLI doesn't look for files elsewhere (the MCP server
does; see below).

- Re-fling to update. Identical content is a no-op, and content you deployed before is restored
  instantly without uploading.
- **Fling never publishes dotfiles, gitignored files, secret files (keys, certs, credentials) or
  files that contain secrets; it stops and tells you which file and line.** There is no flag to
  override this, and the server enforces it too.
  - Dotfiles and dot-folders (`.env`, `.dev.vars`, `.npmrc`, `.git/`, `.well-known/`…) are skipped,
    and the output lists what was skipped (`skipped` in `--json`).
  - Gitignored files are skipped. When the folder you fling is itself gitignored (the usual
    `dist/` or `build/`), only the `.gitignore` files inside it apply.
  - Secret files by name (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa`…,
    `credentials(.json)`, `*service-account*.json`, `*.tfstate`, `*.tfvars`, `secrets.json/yml`,
    `*.kdbx`, `wp-config.php`) stop the fling.
  - Files that contain a secret (private keys, AWS / GitHub / npm / Slack / Stripe / OpenAI /
    Anthropic / SendGrid / Azure keys and tokens, Google OAuth client secrets, database URLs with a
    password) stop the fling with the file, line and kind of secret (never the secret itself).
    Remove the secret (and rotate it if it was ever shared), or add the file to `.flingignore`.
- `node_modules` and anything listed in a `.flingignore` (gitignore syntax) are skipped too.
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
fling Site name: rocketpod-docs → https://rocketpod-docs.sites.example.com/  (new)
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
| `fling ls [--archived] [--sort updated\|created\|name]` | your sites, last updated first (`created`: newest first; `name`: A–Z) |
| `fling info <name>` / `fling versions <name>` | details and version history |
| `fling files <name> [versionId]` | the files in the live version (or an earlier one) |
| `fling rollback <name> <versionId>` | serve an earlier version |
| `fling share <name> [--refresh] [--revoke]` | public share link: print or create it, rotate it, or remove it |
| `fling visibility <name> private\|public` | require sign-in, or not |
| `fling access <name> [--add <emails>] [--remove <emails>] [--clear]` | who can open a private site: everyone signed in, or only listed people |
| `fling archive <name>` / `fling unarchive <name>` | take offline and keep the files, or bring back |
| `fling rm <name> [--yes]` | delete permanently |

### Who can open a private site

A private site opens to everyone signed in to your Fling. `fling access` limits it to listed people
(its audience); you, the owner, can always open it:

```sh
fling access my-app                                   # who can open it now
fling access my-app --add bob@example.com,cat@example.com
fling access my-app --remove bob@example.com
fling access my-app --clear                           # everyone signed in again
```

Addresses are comma-separated or given after `--add` one by one, and each must be one that can sign
in to the Fling. Someone who hasn't signed in yet is marked `(hasn't signed in yet)`; they can open
the site once they do. The audience only applies while the site is private: on a public site it is
kept for later and `fling access` says so. A share link still opens a restricted site to anyone who
has it, and `fling access` warns while one exists. Removing someone shuts them out within 15
minutes. `--json` prints the site with its `audience` (`{ emails: [{ email, known }], groups }`)
and `warnings`; `fling info` shows the same line, and `fling ls --json` gives each site's
`restricted` and `audienceSize`.

## Comments

People review a site on its review page (`<your Fling>/review/<name>`, the **Review** button on the
sites page): the site beside its comments. Anyone signed in who can open the site can comment; the
CLI reads and writes the same threads. On a Fling with comments, `fling deploy` (and the MCP
server's `fling_deploy` / `fling_publish`) also prints the review page as the link to share for
feedback (`reviewUrl` in `--json`); reviewers sign in to use it.

| Command | |
|---|---|
| `fling comments <name> [--path <page>] [--all]` | open threads (with replies) by page; `--all` adds resolved ones |
| `fling comment <name> "text" [--path <page>]` | comment on a page (default `/`) |
| `fling comment <name> "text" --reply <id>` | reply to a thread |
| `fling resolve <name> <id> [--reopen]` | resolve a thread, or reopen it |
| `fling uncomment <name> <id> [--yes]` | delete a comment (a thread with its replies): your own, or any on your site |

Global options: `--json` prints machine-readable output, and `--server <url>` points one command at
another server (a remembered one brings its key; see [Several Flings](#several-flings)). Exit codes are `0` ok, `1` error, `2` not logged in and `3` forbidden.

Environment: `FLING_API_KEY`, `FLING_URL`, `FLING_CONFIG_DIR`, `FLING_DEBUG`, `FLING_DOWNLOADS_DIR`
(where the MCP server looks for files given by name first), `FLING_ADD_SERVER` (a Fling the MCP
server adds to the remembered ones when it starts), `FLING_NO_WAIT=1` (after a deploy or a new share
link, don't wait the few seconds it takes to reach every edge).

## Claude Code plugin and MCP

The Fling plugin gives Claude a `fling` skill plus an MCP server (`fling mcp`), so you can say
"fling the dist folder and give me a share link":

```sh
fling setup
```

Or install it by hand in Claude Code:

```
/plugin marketplace add nearform/fling
/plugin install fling@fling
```

Log in once with `fling login <url>` (or `npx @nearform/fling login <url>` if it is not installed).
The MCP server reuses your logins. It re-reads the config on every call, so a `fling login` or
`fling use` in a terminal takes effect without a restart.

**Several Flings.** The MCP server knows every Fling the CLI remembers, and every tool that talks to
a Fling takes an optional `server`: its address, host or a unique part of it (as `fling use`
accepts).

- With one Fling (or none), calls go to it and `server` can be left out. The tool descriptions
  name that Fling and where its sites live.
- With several, the server is chosen explicitly. The instructions and descriptions list the Flings
  by host and mark the current one. Claude settles which Fling the conversation uses at the start,
  from your words ("on the other one", "on fling.example.com") or by asking you, with your current
  Fling as the suggestion. It says which one it is using and passes it as `server` on every call,
  switching only when you ask. A call without `server` (reads included) does not run: it answers
  with the list of Flings so Claude can ask.
- `fling mcp --server <url>` (or `FLING_URL`) pins the server: calls without `server` go there.
- The CLI itself is unchanged: `fling use` and the current Fling govern CLI commands.

The MCP tools:

- `fling_deploy`: a folder, `.html`, `.zip` or other file on this computer, by path or just its
  name (looked up like the CLI does).
- `fling_publish`: files passed inline, for content Claude wrote in the conversation. It has the same
  definition as the remote connector's tool.
- `fling_find_files`: recent `.html`/`.zip` files and folders with an `index.html` in those folders,
  newest first (last 14 days by default).
- `fling_login`: opens the browser sign-in. If you haven't finished after about 30 seconds it returns
  and keeps waiting in the background for up to 5 minutes. With `server` it signs in to another
  Fling, including a new one, which becomes current only if none is.
- `fling_servers`: lists the Flings on this computer (address, name, who is signed in, which is
  current), read when called. `{use: <server>}` makes one current, the same as `fling use`.
- `fling_check_name`, `fling_list`, `fling_info`, `fling_files`, `fling_share`,
  `fling_set_visibility`, `fling_archive`, `fling_rollback`, `fling_delete` (needs
  `confirm: true`), `fling_whoami`, the comment tools when a Fling has comments, and
  `fling_set_audience` (`add`, `remove`, `set` or `clear` the people who can open a private site)
  when it can limit sites to listed people.

Results that give URLs (deploys, publishes, comments) end with the Fling they went to.

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

1. Download `fling.mcpb` from any Fling (Get started → Download, or `https://<your Fling>/downloads/fling.mcpb`).
2. Double-click it, or drag it into Claude Desktop, or go to **Settings → Extensions → Advanced
   settings → Install Extension…** and pick the file.
3. Optional setting: **Downloads folder** (default `~/Downloads`).
4. Ask Claude to "fling Pitch Deck.html from my Downloads". If you're not signed in, Claude calls
   `fling_login` and your browser opens. The extension and the CLI share the logins in
   `~/.fling/config.json`.

There is one extension for every Fling. When it starts, it adds the Fling you downloaded it from to
the ones this computer knows (if it isn't there yet) without changing the current one, unless none
is current. Installing a copy from another Fling updates the same extension in place. To use
another Fling, ask Claude to sign in to it (`fling_login` with its address) or run
`fling login <url>`. With several Flings, Claude agrees with you which one to use, as described in
[Several Flings](#claude-code-plugin-and-mcp) above.

It needs Node.js 20 or later, which Claude Desktop provides, on macOS or Windows.

Build it with `pnpm --filter ./apps/cli build:mcpb`. That bundles `src/mcp-entry.ts` and every
dependency into one file, then validates and packs `mcpb/manifest.json` into `dist/fling.mcpb`
(with `FLING_MCPB_SERVER_URL` set, its origin is baked into the extension's env as
`FLING_ADD_SERVER`, the Fling added on start). A deploy publishes it at `/downloads/fling.mcpb`.

To use the MCP server in another client, run it over stdio:

```json
{ "command": "npx", "args": ["-y", "@nearform/fling@latest", "mcp"] }
```

## Development

From the repo root:

```sh
pnpm cli login http://localhost:47101   # against `pnpm dev`
pnpm --filter ./apps/cli test
pnpm --filter ./apps/cli build         # → dist/cli.js
```
