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
> `fling login <url>` once with your Fling's address. See the
> [changelog](https://github.com/nearform/fling/blob/main/CHANGELOG.md).

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
   live, how people sign in) and remembers it. Your browser opens for sign-in (on a Fling with two
   sign-in providers, its login page, to choose one) and an API key is
   stored in `~/.fling/config.json` (mode 0600). This is skipped if you're already signed in.
   The server becomes your current one; logins to other Flings are kept.
   When you are already signed in, it reads the server's `/.well-known/fling` again, so the CLI
   knows the release it runs now.
2. **Adds Fling to Claude Code.** If `claude` is on your PATH, setup installs the Fling plugin
   (skill + MCP server) from the `nearform/fling` marketplace. `--scope project|local` installs it
   for this project only (default `user`). When the plugin is already installed, setup refreshes
   it instead (`claude plugin marketplace update fling`, then `claude plugin update fling@fling`)
   and says which version it went from and to; restart Claude Code (or run `/reload-plugins`)
   after an update. A refresh that fails is reported and leaves the installed plugin as it was;
   it doesn't fail setup.
3. **Adds Fling to Claude Desktop.** If Claude Desktop is installed (macOS, Windows), setup
   downloads the `fling.mcpb` of the CLI's own version and opens it, and Claude Desktop asks you
   to confirm. That is the server's copy when the server runs the same release, otherwise the one
   attached to the CLI's GitHub Release (the server's copy if that download fails). Running setup
   again updates an older extension in place.

On a terminal it asks before installing the plugin and before step 3. With `--yes` it does them
without asking. Refreshing an installed plugin needs no question.

### Staying up to date

Every Fling publishes the release it runs (`release` in `/.well-known/fling`). After a command, when
the server it used runs a newer release than the CLI, the CLI prints one line on stderr:

```
▲ Fling 0.9.0 is out (this CLI is 0.8.0). Update: npm i -g @nearform/fling@latest && fling setup
```

It compares with the metadata the CLI already holds (stored at sign-in, and read again by setup and
by commands that need a newer feature), so it never makes a request of its own. It says it at most
once a day per server, remembering when in `update-check.json` in the config directory. It says
nothing under `--json`, when stderr isn't a terminal, when `CI` is set, or when
`FLING_NO_UPDATE_CHECK` is set (to anything). A server older than the CLI says nothing either. The
MCP server tells Claude instead (see [Claude Code plugin and MCP](#claude-code-plugin-and-mcp)).

### When something doesn't work

`fling doctor` checks the setup and prints one line per check, `✔` ok, `▲` warning or `✖` problem,
each warning and problem with its fix:

- **CLI:** its version, Node.js against the versions it supports, the latest version on npm
  (skipped when npm can't be reached), and whether `fling` on your PATH is this CLI.
- **Config:** where it lives (`FLING_CONFIG_DIR`), whether the config file is private (mode 0600:
  it holds your API keys), and whether `FLING_URL` or `FLING_API_KEY` is in effect (named, never
  shown).
- **Each Fling** you signed in to, the current one marked: whether its `/.well-known/fling`
  answers, the release it runs against the CLI's, whether your API key is still accepted, and the
  features it reports.
- **Claude Code:** `claude` on your PATH, the Fling plugin (installed, enabled, its version against
  the CLI's) and the `fling` marketplace.
- **Claude Desktop:** whether the extension is installed, enabled, and its version.

It only reads: it changes nothing, and each request has a short timeout. `--json` prints
`{ ok, checks: [{ area, id, status, message, fix?, server? }] }`. The exit code is 1 when any check
is a problem.

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
fling deploy ./dist --access members       # a new site everyone signed in can open
fling deploy ./dist --access people --add bob@example.com   # only you and Bob
fling deploy ./dist --access public        # no sign-in needed to view
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
- **Publish one folder of a site** with `--path` (and `--name`): `fling deploy ./report --name
  changelog --path 30-10-26` serves the report at `https://changelog.<sites domain>/30-10-26/` and
  keeps every other file of the site. Only the folder's files are uploaded; the server copies the
  rest into the new version (at most 1,000 files, else `too_large`: deploy the whole site). If
  someone else publishes the site in between, the deploy runs once more on top of theirs. `fling
  versions` shows where each one went (PATH), and rolling back removes it. On a Fling without path
  publishing (`pathPublish`) the CLI refuses rather than replace the whole site.
- **Change a site you can open** with `fling pull <name> [dir]`: it downloads the current version
  into `dir` (default `./<name>`) with a site link, `.fling-site.json`, naming the server, the site
  and the version pulled. `fling deploy <dir>` then publishes to that site on that version and
  uploads only what changed (`3 changed, 1 removed`). If someone published the site since you
  pulled, it stops (`base_changed`) rather than overwrite their work: pull again into another
  folder and redo your change, or `fling deploy <dir> --force` to replace what they published.
  `--path <folder>` pulls one folder of the site; `--version-id <id>` another version (owners and
  publishers). Anyone signed in who can open the site may pull it; only its owners and publishers
  may deploy. A folder that isn't empty needs `--force`. On a Fling without the `pull` capability
  the CLI says so.
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
| `fling ls --shared [--sort …]` | the restricted sites others have shared with you: owner, and how (your address or a group) |
| `fling info <name>` / `fling versions <name>` | details and version history, with who published each version and, for a path publish, the folder (PATH) |
| `fling pull <name> [dir] [--path <folder>] [--version-id <id>] [--force]` | download a site's files to change them; `fling deploy <dir>` publishes on the version pulled |
| `fling files <name> [versionId]` | the files in the live version (or an earlier one) |
| `fling rollback <name> <versionId>` | serve an earlier version |
| `fling share <name> [--refresh] [--revoke]` | public share link: print or create it, rotate it, or remove it |
| `fling visibility <name> private\|public` | require sign-in, or not (private again: the access it had) |
| `fling access <name> [--only-me \| --members \| --public] [--add <emails>] [--remove <emails>] [--group <slugs>] [--remove-group <slugs>] [--clear]` | who can open a site: only you, listed people and groups, everyone signed in, or anyone |
| `fling owners <name> [--add <emails>] [--remove <emails>] [--set <emails>] [--group <slugs>] [--remove-group <slugs>]` | who owns a site, or change it |
| `fling publishers <name> [--add …] [--remove …] [--set …] [--group …] [--remove-group …]` | who publishes a site without owning it, or change it |
| `fling archive <name>` / `fling unarchive <name>` | take offline and keep the files, or bring back |
| `fling rm <name> [--yes]` | delete permanently |

An admin of the instance can read anyone's site with these commands (`fling info`, `fling files`,
the comments). Changing someone else's site needs the admin's browser session: open it from All
sites in the web app.

### Who can open a site

Each site has an access level: **only you**, **teams** (groups), **specific people**, **everyone
signed in** to your Fling, or **public**. A new site gets the one you give with `deploy --access
only_me|members|groups|people|public` (with `--add <emails>` and `--group <slugs>` for people and
teams); without it, your Fling's default, which is only you unless it is set up otherwise, and the
deploy says who can open it. A re-deploy never changes it. `fling ls` shows each site's level in
its ACCESS column and `fling info` on its Access line.

`fling access` shows and changes it. `--only-me`, `--members` and `--public` set the level; the
audience options limit the site to listed people and groups (its audience); you, the owner, can
always open it:

```sh
fling access my-app                                   # who can open it now
fling access my-app --only-me                         # nobody else
fling access my-app --members                         # everyone signed in
fling access my-app --add bob@example.com,cat@example.com
fling access my-app --remove bob@example.com
fling access my-app --group design                    # everyone in the design group too
fling access my-app --remove-group design
fling access my-app --clear                           # empty the audience: everyone signed in
fling access my-app --public                          # anyone, no sign-in
```

Addresses are comma-separated or given after `--add` one by one, and each must be one that can sign
in to the Fling. Where the Fling invites people from outside (its `invites` capability), an outside
address is invited as a **guest**: a reviewer who signs in with a link emailed to them and sees only
what is shared with them, marked `(guest)`. You can invite a few new outside addresses a day; past
that, nothing changes and the CLI says so (`too_many_invites`). The same goes for `fling groups
create` and `fling groups add`. Someone who hasn't signed in yet is marked `(hasn't signed in yet)`;
they can open the site once they do. The audience only applies while the site is private: on a public site it is
kept for later and `fling access` says so. A share link still opens a restricted site to anyone who
has it, and `fling access` warns while one exists. Removing someone shuts them out within 5
minutes. `--json` prints the site with its `audience` (`{ emails: [{ email, known, guest? }], groups:
[{ slug, name, size }] }`) and `warnings`; `fling info` shows the same line, and `fling ls --json`
gives each site's `access`, `restricted`, `audienceSize` and `audienceGroups` (how many of those
are groups). A share link opens a site only you can see as well: it is your choice to hand it out.

`fling ls --shared` lists the other side: the restricted sites whose audience names you, or a group
you are in, with their owner and how they reached you. With `--json`, each is `{ name, url,
reviewUrl?, owner, via: { direct, groups }, createdAt, updatedAt }`. Your own sites, and private
sites open to everyone signed in, aren't listed.

### Owners and publishers

A site's **owners** are equal: each can publish it, roll it back, change who can open it and its
settings, its owners and publishers, archive and delete it. Its **publishers** can publish and roll
back, and nothing else. Both are people and groups, and only people who can sign in to your Fling
as members (never guests) can hold either:

```sh
fling owners my-app                                   # who owns and publishes it, and your role
fling owners my-app --add cat@example.com             # Cat owns it too
fling owners my-app --remove you@example.com          # hand it over (someone else must own it)
fling publishers my-app --add bob@example.com --group design
fling publishers my-app --remove-group design
fling publishers my-app --set bob@example.com         # exactly these addresses (groups stay)
```

A site always keeps at least one person as an owner, so `--remove` of the last one is refused
(`last_owner`); a group alone never counts. Someone in both lists is an owner. Naming a group
trusts whoever manages it: anyone they add owns or publishes the site too. People you add are told
by email where your Fling sends it. `fling ls` shows your ROLE on each site (owner, publisher, or
admin for an admin's view), and `fling info` its Owners, Publishers and You. As a publisher,
`fling deploy` publishes new content, but can't change the site's access or settings (`--access`,
`--public`, `--spa` that differ: `owner_only`) or bring an archived site back. With `--json`, the
commands print `{ name, role, owners, publishers }`, each list `{ emails: [{ email, known, guest?
}], groups: [{ slug, name, size }] }`.

### Groups

A group is a named list of people, such as a team, that anyone signed in can use in a site's
audience. Everyone can list groups and see who is in one; only the group's owner, who made it, can
change its members, rename it or delete it:

```sh
fling groups                                          # every group (--mine: only yours)
fling groups --members bob@example.com,cat@example.com  # the groups of exactly these people
fling groups show design                              # its members
fling groups create design --name "Design team" --add bob@example.com,cat@example.com
fling groups add design dan@example.com
fling groups remove design bob@example.com
fling groups rename design "Designers"
fling groups delete design                            # asks first unless --yes
```

A slug is lowercase letters, digits and single hyphens, unique on the Fling; a group holds up to 500
people, and an audience names up to 10 groups. Taking someone out of a group shuts them out of the
sites it opens within 5 minutes. Deleting a group never opens a site up: sites whose audience
names it keep their restriction, and anyone it let in loses access. Where it was the only entry,
`fling access` shows "a deleted group (#<id>)" and only you can open the site until you add
people or groups (`--remove-group '#<id>'` takes the reference out).

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

## Forms

A form collects structured feedback on a site's review page: a label per page, rubric scores, an
A/B preference, a flagged passage's severity. It is a JSON Schema the review page renders, and
reviewers' answers (responses) come back as data you can export, instead of codes typed into
comments. On a Fling with forms (the `forms` capability, on with comments), put a
`fling.forms.json` at the top of the folder you deploy:

```sh
fling forms init ./dist --template labels --title Labels   # a starter: labels, rubric, compare, issue or survey
fling forms check ./dist                                   # as a deploy will: errors, and the pages each form applies to
fling deploy ./dist                                        # sends it as the site's forms (never served as a file)
fling responses my-app                                     # who answered which page, and how far each form has got
fling responses my-app --format csv -o labels.csv          # the export: json, jsonl or csv
```

- `fling deploy` checks the file against the folder's pages and stops on errors. After the deploy
  it lists each form and the pages it applies to (`forms` in `--json`). Without the file, it ends
  with one line on adding a form (`formsHint` in `--json`; `--quiet` leaves it out).
- Without the file, deploying a whole site removes its forms. A `--path` deploy keeps them, and so
  does a pulled folder, unless it was pulled with a `fling.forms.json` you have since deleted.
- `fling pull` writes the site's `fling.forms.json` back into the folder.
- On a form with `"visibility": "own"`, reviewers see only their own answers; the site's owners see
  everyone's.

| Command | |
|---|---|
| `fling forms <name> [--path <page>]` | the live forms: a line per form, then the config as JSON (`> fling.forms.json` saves it) |
| `fling forms init [dir] [--template <name>] [--title <title>] [--force]` | write a starter `fling.forms.json` |
| `fling forms check [path]` | check a folder's `fling.forms.json` (or a file) against the folder's pages |
| `fling responses <name> [--form <id>] [--path <page>] [--format json\|jsonl\|csv] [-o file]` | the responses as a table with progress, or the export |

## Notifications

A Fling with email tells you when a site is shared with you (directly or through a group), when
you are added to a group, and when someone comments on your site or replies in your thread. You
choose what you hear about, per event and channel; the same settings are on the web app's
**Settings → Notifications** page, and every email has a link to stop that kind of email.

| Command | |
|---|---|
| `fling notifications` | a table of events × channels: on or off, `*` where you chose it rather than the default |
| `fling notifications set <event> <channel> on\|off\|default` | change one event on one channel (`default`: back to the Fling's default), e.g. `fling notifications set comment.created email off` |
| `fling notifications mute` / `unmute` | stop everything, or start again (your choices are kept) |
| `fling notifications sent` | what was sent to you in the last 30 days: when, the subject and its events |

On a Fling without notifications they say so. `--json` prints the settings as the API returns them
(`{ channels, events, muted, cells, overrides }`) or `{ sent: [...] }`.

Global options: `--json` prints machine-readable output, and `--server <url>` points one command at
another server (a remembered one brings its key; see [Several Flings](#several-flings)). Exit codes are `0` ok, `1` error, `2` not logged in and `3` forbidden.

Environment: `FLING_API_KEY`, `FLING_URL`, `FLING_CONFIG_DIR`, `FLING_DEBUG`, `FLING_DOWNLOADS_DIR`
(where the MCP server looks for files given by name first), `FLING_ADD_SERVER` (a Fling the MCP
server adds to the remembered ones when it starts), `FLING_NO_WAIT=1` (after a deploy or a new share
link, don't wait the few seconds it takes to reach every edge), `FLING_NO_UPDATE_CHECK` (never say
that a newer Fling release is out; see [Staying up to date](#staying-up-to-date)).

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
  name (looked up like the CLI does). `sitePath` (with `name`) publishes it into that folder of the
  site and keeps the rest, like `--path`. A folder pulled with `fling pull` or `fling_pull` deploys
  on the version pulled, like the CLI; `force: true` publishes over whatever is live.
- `fling_pull`: downloads a site into a folder on this computer (default
  `~/Documents/Claude/fling/<name>`) to change it and deploy it again with `fling_deploy`.
- `fling_read_files`: a site's files inline, a page at a time, for reading without a download.
- `fling_publish`: files passed inline, for content Claude wrote in the conversation. It has the same
  definition as the remote connector's tool; `path` publishes them into that folder of the site;
  `base` (a version from `fling_read_files`) sends only the files that changed, and `remove` names
  files to delete.
- `fling_find_files`: recent `.html`/`.zip` files and folders with an `index.html` in those folders,
  newest first (last 14 days by default).
- `fling_login`: opens the browser sign-in. If you haven't finished after about 30 seconds it returns
  and keeps waiting in the background for up to 5 minutes. With `server` it signs in to another
  Fling, including a new one, which becomes current only if none is.
- `fling_servers`: lists the Flings on this computer (address, name, who is signed in, which is
  current), read when called. `{use: <server>}` makes one current, the same as `fling use`.
- `fling_doctor`: the checks of `fling doctor`, read-only, as lines and data. Claude calls it when
  something about Fling doesn't work (sign-in, tools missing, versions) and tells you the fixes.
- `fling_check_name`, `fling_list`, `fling_info`, `fling_files`, `fling_share`,
  `fling_set_visibility`, `fling_archive`, `fling_rollback`, `fling_delete` (needs
  `confirm: true`), `fling_whoami`, the comment tools when a Fling has comments, the forms tools when it has forms
  (`fling_forms`, `fling_forms_template`, `fling_forms_check`, `fling_responses_list`, and
  `fling_response_submit`, which answers a form as you, only when you ask), and
  `fling_set_audience` (`add`, `remove`, `set` or `clear` the people who can open a private site,
  and `addGroups`, `removeGroups`, `setGroups` for groups) when it can limit sites to listed
  people, `fling_set_owners` and `fling_set_publishers` (the same changes, to a site's owners or
  publishers) where it has site roles, and the group tools (`fling_groups`, `fling_group_show`, `fling_group_create`,
  `fling_group_members`, `fling_group_rename`, `fling_group_delete`) when it has groups, and
  `fling_notifications` and `fling_notifications_set` (`muted`, and `cells` of
  `{ event, channel, value: on|off|default }`) when it has notifications.

Results that give URLs (deploys, publishes, comments) end with the Fling they went to.

**Updates.** When a Fling the MCP server knows runs a newer release than it, its instructions say
so, and so does the first `fling_publish` or `fling_deploy` result of the session on that Fling.
Claude then suggests the update command (`npm i -g @nearform/fling@latest && fling setup`, then
restart Claude): inside Claude you never see the CLI's own update line.

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
