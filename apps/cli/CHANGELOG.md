# Changelog

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

## 0.2.0

`fling setup`, a new look, and help by default.
