# Changelog

Every user-visible change to Fling, in any part of it (the server, the web UI, the CLI, the MCP
servers, the Claude Desktop extension and the plugin), with upgrade notes where a change asks
something of you. One version covers them all: a release is tagged `v<version>` and published as a
GitHub Release with its section below as the notes ([Releasing](docs/development.md#releasing)).

Every pull request that changes behaviour adds a bullet under `## Unreleased`: a bold lead naming
the change, then what it does, in plain British English. Upgrade notes start with "Upgrade note:"
or "Upgrading:". `pnpm release <version>` moves the Unreleased bullets under the new version.

Up to 0.6.0, each release was the CLI's alone (tagged `cli-v<version>`).

## Unreleased

## 0.10.1 (2026-11-05)

- **Security updates to dependencies.** The web UI runs on React Router 7.18, and the tests on
  Vitest 4.1. Patched versions of undici, sharp, tmp and zod replace the vulnerable ones pulled in
  by Miniflare and the Claude Desktop extension's packer. Nothing changes in how Fling behaves.

## 0.10.0 (2026-11-05)

- **Paths: one site, a folder per ticket.** A one-folder path publish (`fling deploy ./plan
  --name payments-plans --path PAY-412`, `path` on `fling_publish`) now publishes that folder as a
  Path: its own versions, rollback, owners and publishers, served at `/PAY-412/`, with the site's
  access. Publishing a Path never changes the site's own pages or another Path, so teammates
  publishing different Paths never collide, and each rolls back alone. Whoever makes a Path owns
  it; the site's owners own it too, and a site publisher can't replace someone else's Path
  (`path_not_yours`). `fling paths <site>`, `--path` on `versions`, `rollback`, `files`, `owners`
  and `publishers`, `fling_paths` and `path` on `fling_info`, `fling_rollback` and `fling_files`,
  `/api/sites/<name>/paths`, and a Paths section and Path page in the web UI. Comments on a Path's
  pages go to its owners. Forms stay the site's: a Path publish carrying a forms config is refused,
  and the site's forms reach a Path's pages through their `paths` patterns. The `paths` capability.
- **The site's home page lists its Paths.** A site with Paths and no index.html of its own gets a
  listing of them with search, sort and "2 hours ago" dates for the last week; an index.html of its own lists them wherever it puts a
  Paths block (`<!-- fling:paths -->`, or a template repeated per Path), and the data is at
  `/_fling-paths.json`. `fling paths init --template plans|docs|reports|minimal` and
  `fling_paths_template` write a starter page; `fling paths check` and `fling_paths_check` check
  one. Publish results (and `fling deploy --json`, which now gives the `versionId`) carry hints: `paths_index_missing` when a site has several Paths and a home
  page that doesn't list them, `paths_block_hidden` when a publish sends files under a Path's
  folder, which the Path hides. The skill offers a team site when it sees one coming, and asks
  first.
- **Markdown is served as pages.** `.md` files are rendered as GitHub-flavoured Markdown when a
  version goes live, and served rendered; `?raw=1` serves the source, a page of its own on the review page (a comment on it reopens there). A folder's `index.md`, else
  `README.md`, else its only Markdown file, is its home page. The `markdown` capability.
- **Retention.** `VERSION_RETENTION` (default 0: keep every version) keeps that many complete
  versions of each site and Path besides the current one. An hourly maintenance run marks the
  rest and deletes them at least an hour later, unless one is published again or rolled back to
  meanwhile; it also deletes deploys staged and never finalized for a day, and replaced rendered
  home pages.
- **One kind of partial publish.** A publish can no longer replace a nested folder of a site and
  carry the rest forward: `path` is one top-level folder, a Path, and `reports/2026` is refused.
  A publish on a pulled version (`base`, after `fling pull` or `fling_read_files`) still sends only
  what changed, for the site or, with `path`, for one Path; `fling pull --path F` pulls that Path.
- Upgrade note: on AWS, the module adds an hourly EventBridge Scheduler schedule and its role
  (`<namespace>-<env>-<name>-maintain`), so `terraform apply` creates them. Versions published
  before this release keep serving Markdown as it is until they are published again. A folder
  that was path-published before is the site's own folder: publish it with `--path` once to make
  it a Path, which then hides the site's copy. Rolling back to an earlier release stops serving
  Paths (their folders serve the site's own copy, or 404) until you roll forward again; nothing is
  lost. A CLI or MCP server from before this release that path-publishes a nested folder gets a
  400; one folder works as a Path.

## 0.9.0 (2026-11-03)

- **The CLI says when a newer Fling release is out.** After a command, when the server it used
  runs a newer release (`release` in `/.well-known/fling`) than the CLI, it prints one line on
  stderr, "Fling 0.9.0 is out (this CLI is 0.8.0)", with the commands that update it: the
  `npm i -g` of the latest CLI, then `fling setup`. It uses the metadata the CLI already holds,
  at most once a day per server, and never under `--json`, off a terminal, in CI or with `FLING_NO_UPDATE_CHECK` set. The local MCP
  server puts the same news in its instructions and in the session's first `fling_publish` or
  `fling_deploy` result, so Claude passes it on.
- **`Fling-Release` on every response.** The API, sign-in and MCP routes say which release the
  server runs in a `Fling-Release` header (the metadata's `release`). The CLI and its MCP server
  store a release that differs from the one they hold, so the update check notices a new server
  release from any call, not only after signing in again. It needs both the server and the CLI
  on this release; older CLIs ignore the header.
- **`fling setup` refreshes what it installed.** With the plugin already in Claude Code, setup
  updates the `fling` marketplace and the plugin without asking, says which version it went from
  and to, and says to restart Claude Code; a failed refresh is reported and no longer fails setup.
  The Claude Desktop extension it opens is the CLI's own version (the server's copy when the server
  runs that release, otherwise the CLI's GitHub Release), and setup reads the server's metadata
  again when you are already signed in.
- **`fling doctor` and `fling_doctor`.** A read-only check of the CLI (version, Node.js, the latest
  on npm, `fling` on PATH), its config (location, file permissions, `FLING_URL` / `FLING_API_KEY`
  in effect), each Fling (reachable, release, sign-in, features), the Claude Code plugin and
  marketplace, and the Claude Desktop extension, one line per check with the fix. `--json` prints
  the checks; the exit code is 1 on a problem. The local MCP server's `fling_doctor` runs the same
  checks for Claude.
- **Answering forms on the review page.** While a form tab is open, selecting text in the page no
  longer starts a comment, so the text can be copied into an answer. With one form on a page,
  "Save and next" saves the answer and opens the next page without one; "Save" stays on the page.

## 0.8.0 (2026-11-03)

- **Forms.** A site can ship `fling.forms.json` with its deploy: forms (JSON Schemas) its reviewers
  answer on the review page, for labels, ratings, rubric scores or eval judgements. A page-kind
  form takes one answer per reviewer per page, in a tab named after the file's `title`, with each
  reviewer's progress; a comment-kind form is a type of comment, pinned like any other.
  `"visibility": "own"` shows reviewers only their own answers, and owners and admins everyone's.
  The file is never served; a path publish or a deploy of a pulled folder keeps it, and `fling pull`
  brings it back. New commands: `fling forms <name>`, `fling forms init`, `fling forms check` and
  `fling responses` (a table with progress, or JSON, JSON Lines and CSV). New MCP tools on both
  servers: `fling_forms`, `fling_forms_template`, `fling_forms_check`, `fling_responses_list` and
  `fling_response_submit`; `fling_publish` and `fling_deploy` take `forms`. The site page links to
  the new responses page, a page × reviewer grid per form with the downloads.

- **Forms come with comments.** The `forms` capability is on wherever comments are, with no new
  configuration: `COMMENTS=false` turns both off. Operators have nothing to do: the comment record
  gains optional response fields (v2), which need no migration. Rolling back to 0.7.0 keeps every
  comment readable; a response shows as its summary text.

## 0.7.0 (2026-11-01)

- **Two sign-in providers.** A Fling can offer a Google client and another OpenID Connect issuer
  side by side, listed in its metadata (`auth.providers`). On one, `fling login` (and
  `fling_login`) opens the Fling's login page with a button for each, and comes back with a key
  whichever is used. A Fling with one provider signs in as before. Upgrade note for operators: an
  instance with `OIDC_ISSUER` that still has the `google-client-id` and `google-client-secret`
  parameters now offers Google too; delete them if it shouldn't. Without `OIDC_DISPLAY_NAME`, an
  issuer Fling doesn't know is labelled "Single sign-on" rather than its host name.

- **One version for all of Fling.** The server, the web UI, the CLI, the MCP servers, the Claude
  Desktop extension and the plugin are released together under one version, continuing the CLI's
  numbering, with this changelog for all of them. Each release is a GitHub Release with its notes
  and the extension attached. A server says which release it runs as `release` in
  `/.well-known/fling`. The npm package no longer ships a copy of the changelog; its README links
  here.

- **Path publish.** `fling deploy <dir> --name <site> --path <folder>` publishes the folder into
  that folder of the site (`<site>/30-10-26/`) and keeps the rest. When someone else published the
  site meanwhile it deploys once more on top of theirs. `fling versions` has a PATH column and
  `fling info` a Published to line. The MCP tools take `path` on `fling_publish` (and the remote
  `fling_upload_begin`) and `sitePath` on `fling_deploy`. On a Fling without the `pathPublish`
  capability they refuse instead of replacing the whole site.

- **Pull.** `fling pull <name> [dir]` downloads a site's files into a folder, for anyone signed in
  who can open the site (`--version-id` for another version, for owners and publishers; `--path`
  for one folder). `fling deploy` of that folder publishes on the version pulled and uploads only
  what changed; if someone published the site since, it stops and says so rather than overwrite
  their work (`--force` publishes anyway). The MCP tools gain `fling_pull` (local),
  `fling_read_files` (both servers, for agents that can't download) and `base` and `remove` on
  `fling_publish`, so an agent can change one file of a site without sending the rest. The site
  page shows the `fling pull` command to those who may pull. On a Fling without the `pull`
  capability the commands say so.

- **Owners and publishers.** `fling owners <name>` and `fling publishers <name>` show who owns and
  who publishes a site and, with `--add`, `--remove`, `--set <emails>`, `--group` and
  `--remove-group <slugs>`, change one list. Owners are equal; publishers publish and roll back,
  and change nothing else. `fling ls` has a ROLE column (owner, publisher or admin) and `fling
  info` shows Owners, Publishers and You. The MCP tools `fling_set_owners` and
  `fling_set_publishers` take the same changes as `fling_set_audience`, and `fling_info` and
  `fling_list` say the user's role. On a Fling without the `siteRoles` capability the commands say
  so and change nothing.

- **Who published.** Each version records who published it. `fling versions` shows a BY column,
  `fling info` a Published by line for the current version, and `fling_info` names the publisher
  of each version. Versions published before a Fling recorded it show `-`.

- **Access levels.** A site is open to only you, teams, specific people, everyone signed in or
  anyone. `fling deploy --access only_me|members|groups|people|public` (with `--add <emails>` and
  `--group <slugs>`) chooses it for a new site; without it a new site gets the Fling's default,
  only you unless the Fling says otherwise, and the deploy says who can open it. A re-deploy never
  changes it. `fling access <name> --only-me | --members | --public` changes it later; `fling ls`
  shows an ACCESS column in place of VISIBILITY, and `fling info` an Access line (the detailed one
  is now Who). The MCP tools `fling_deploy` and `fling_publish` take `access` (with `emails` and
  `groups`), and `fling_set_access` sets any level. Upgrade note: on a Fling with the new default,
  a site you create without `--access` is no longer visible to everyone signed in; pass
  `--access members` for that, or `fling access <name> --members` afterwards.

- **Notifications.** On a Fling with email, `fling notifications` shows what it tells you about
  (sites shared with you, groups you are added to, comments on your sites and replies in your
  threads), per event and channel, marking the ones you chose. `fling notifications set <event>
  <channel> on|off|default` changes one, `mute` and `unmute` switch everything, and `sent` lists
  what was sent to you in the last 30 days. The MCP tools `fling_notifications` and
  `fling_notifications_set` (`muted`, `cells: [{ event, channel, value }]`) do the same on a Fling
  with the `notifications` capability.

## 0.6.0

- `fling groups --members a,b` lists only the groups whose members are exactly those people, to
  find a group to use before making another. The MCP tool `fling_groups` takes `members` for the
  same.

- **Shared with me.** `fling ls --shared` lists the restricted sites other people have shared with
  you, by address or through a group you are in, with their owner and how (`--sort` as for
  `fling ls`; `--json`: `{ name, url, reviewUrl?, owner, via: { direct, groups }, createdAt,
  updatedAt }`). The MCP tool `fling_list` takes `shared: true` for the same list, on a Fling with
  the `audiences` capability.

- **Groups.** `fling groups` lists the groups of people on a Fling (`--mine`: yours), and `show`,
  `create`, `add`, `remove`, `rename` and `delete` manage them. Anyone can see a group and use it;
  only its owner can change it. `fling access <name> --group <slugs>` / `--remove-group` put groups
  in a site's audience. The MCP tools `fling_groups`, `fling_group_show`, `fling_group_create`,
  `fling_group_members`, `fling_group_rename` and `fling_group_delete` do the same on a Fling with
  the `groups` capability, and `fling_set_audience` takes `addGroups`, `removeGroups` and
  `setGroups`. A site's `audience.groups` is `[{ slug, name, size }]`, and sites carry
  `audienceGroups`.
- `fling access <name>` shows who can open a private site and, with `--add`, `--remove` or
  `--clear`, limits it to listed people (its audience) or opens it to everyone signed in again.
  It warns while a share link still opens a restricted site, and when the site is public (the
  audience applies once it is private). `fling info` shows the same line.
- The MCP tool `fling_set_audience` (`add`, `remove`, `set`, `clear`) does the same, on a Fling
  that has the `audiences` capability, and `fling_info` says who can open the site.
- Sites in `--json` output carry `restricted` (private with an audience) and `audienceSize`;
  `fling info --json` adds the `audience` itself.
- `fling ls` lists the last updated site first. `--sort updated|created|name` picks the order
  (`created`: newest first; `name`: A–Z). The MCP tool `fling_list` takes the same `sort`.

## 0.5.1

- `fling comments` shows the text a thread is pinned to (`> …` under its header), when a reviewer
  pinned it by selecting text in review mode. The MCP tools return it as the anchor's `quote`.

## 0.5.0

- **One MCP server for every Fling.** The local MCP server (`fling mcp` and the Claude Desktop
  extension) knows every Fling the CLI remembers. Every tool that talks to a Fling takes an
  optional `server` (an address, host or unique part of it), and calls use that Fling's own key.
  An unknown or ambiguous `server` fails with the list of Flings.
- **The server is chosen explicitly when there are several.** With one Fling (or none) nothing
  changes: calls go to it. With several, the instructions and tool descriptions list them by host
  and mark the current one, and tell Claude to settle at the start of a conversation which Fling it
  uses (from your words, or by asking you, suggesting your current one), say so, and pass it as
  `server` on every call. A call without `server`, reads included, doesn't run: it answers with the
  list so Claude can ask. `fling mcp --server` and `FLING_URL` still pin one. The CLI's commands
  are unchanged and follow `fling use`.
- `fling_servers` lists the Flings on this computer (address, name, who is signed in, which is
  current), read when called; `{use: <server>}` makes one current, as `fling use` does.
- `fling_login` takes `server` to sign in to another Fling, including a new one. It becomes the
  current Fling only when none is.
- Deploy, publish and comment results end with the Fling they went to.
- **One extension.** The extension has the same identity whichever Fling serves it, so installing
  it from another Fling updates it in place. The address a Fling bakes in (`FLING_MCPB_SERVER_URL`
  at build time, `FLING_ADD_SERVER` in the extension) is added to the remembered Flings when the
  server starts, if it isn't there yet; it never replaces a stored key and becomes current only
  when none is. The extension's **Fling server** setting is gone.
- Upgrading: remove older Fling extensions from Claude Desktop (Settings → Extensions), then
  install it once from any of your Flings. Earlier extensions were each tied to one Fling.

## 0.4.0

- **Several Flings.** The CLI remembers every Fling you sign in to, each with its own API key, and
  uses the current one. `fling login <url>` and `fling setup <url>` add a Fling (or refresh its
  login) and make it current without signing you out of the others. `fling use` lists them, with
  each one's name and your email; `fling use <url>` switches (a full address, its host or the start
  of it). `fling logout <url>` signs out of another Fling and forgets it; a bare `fling logout`
  still removes the current Fling's key and keeps the Fling. `fling whoami` shows which Fling is
  current.
- `--server` and `FLING_URL` pick a remembered Fling for one command and use its stored key (an
  address you haven't signed in to has no key; `FLING_API_KEY` still overrides). The local MCP
  server uses the current Fling unless `FLING_URL` (the Claude Desktop extension's **Fling server**)
  names one, and signing in from it makes that Fling current only when no other is.
- Upgrading: `~/.fling/config.json` from 0.3 is read as-is, as one remembered Fling that is
  current. It is rewritten in the new shape (`current` plus `servers`, keyed by address) the next
  time the CLI saves it, so an older CLI can no longer read it after that.

## 0.3.0

**Breaking: no default server.** The CLI works with any Fling deployment, so it no longer has one
built in.

- `fling login <url>` (or `fling setup <url>`) signs in to the Fling at that address. The CLI
  reads the server's `/.well-known/fling` (its name, sites domain, sign-in method) and remembers
  both in `~/.fling/config.json`; later commands, and `fling login` without a URL, use them.
  `FLING_URL` and `--server` still override it.
- Upgrading from 0.2: if you logged in with 0.2, nothing changes; the server you logged in to is
  kept, and its metadata is fetched the first time it is needed. A config without a server (a new
  machine, or a key set by hand) fails with `No Fling server set — run fling login <url> …`
  instead of assuming a server.
- Site URLs shown before a deploy come from the server's metadata instead of being guessed from
  the server URL.
- The local MCP server (`fling mcp`, the Claude Desktop extension) names your Fling and its sites
  domain in its tool descriptions. The extension's **Fling server** setting has no built-in
  default; the copy a Fling serves at `/downloads/fling.mcpb` has its address filled in.
- Comments: `fling comments`, `fling comment` (and `--reply`), `fling resolve`, `fling uncomment`;
  the local MCP server gains `fling_comments_list`, `fling_comment_add`, `fling_comment_resolve`
  and `fling_comment_delete` on an instance with the `comments` capability.
- On an instance with comments, a deploy (`fling deploy`, and the MCP server's `fling_deploy` and
  `fling_publish`) also gives the review page, the link to share for feedback: in the output box,
  as `reviewUrl` in `--json` and in the MCP result, where it leads.

## 0.2.0

`fling setup`, a new look, and help by default.
