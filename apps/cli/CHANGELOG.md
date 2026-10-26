# Changelog

## Unreleased

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
