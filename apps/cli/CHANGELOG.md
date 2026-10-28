# Changelog

## Unreleased

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
