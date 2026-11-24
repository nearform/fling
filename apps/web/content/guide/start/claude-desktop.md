---
title: Claude Desktop
part: start
order: 30
summary: Install the Fling extension, so Claude Desktop can fling files from your computer.
sources: [packages/shared/src/sandbox-upload.ts, apps/cli/mcpb/**, apps/cli/src/mcp.ts, apps/cli/src/mcp-entry.ts, apps/cli/src/locate.ts, apps/cli/src/commands/setup.ts, apps/web/src/pages/GetStarted.tsx]
verified: c82d9d4
---

The Fling extension lets Claude Desktop publish files that are on your computer: a page you
downloaded, a report Claude saved, a zip someone sent you, a build folder. Say "fling Pitch
Deck.html" and Claude finds it, publishes it and gives you the link. It works in Cowork too.

The [connector](/guide/start/connect) only sees what is in the conversation. The extension runs on
your computer, so it can reach your files.

## Install it

1. Download the extension: **Download Fling for Claude Desktop** on the **Get started** page of
   the web app, or `{{instance:origin}}/downloads/fling.mcpb`.
2. Double-click the file, or drag it into Claude Desktop. You can also pick it from **Settings →
   Extensions → Advanced settings → Install Extension…**.
3. Confirm in Claude Desktop. Its one setting, **Downloads folder**, is where it looks first for
   files you name; leave it as it is unless you keep downloads elsewhere.

The first time Claude uses it, your browser opens {{instance:name}} to sign in with
{{instance:account}}.

If you use the command line, `fling setup` offers to install the extension for you: see [The
CLI](/guide/start/cli).

## In your assistant

Name the file, or describe it:

- "Fling Pitch Deck.html from my Downloads"
- "Fling the zip I just downloaded as launch-site"
- "Fling ~/work/my-app/dist as my-app"
- "Which HTML files did I download this week?"

Claude looks for a file you name, newest first, in the folder you are working in, your Downloads,
your Desktop, `Documents/Claude` and the folders where Claude Desktop and Cowork save their output.
It tells you where it found the file.

Files Claude makes for you are published from where it saved them, never typed out again. In
Cowork they are already on your computer, so the extension publishes them from there. In a chat
with code execution they are in Claude's sandbox in the cloud, so Claude uploads them from the
sandbox.<!-- requires: sandboxUpload --> For that, `{{instance:host}}` must be allowed once in
Claude's settings: see [Let Claude upload its files](/guide/start/claude-uploads).<!-- /requires -->

What you can fling:

- **A folder**, as it is.
- **One HTML page**, served as the site's home page.
- **A zip of a site**, unpacked first.
- **Any other file** (a PDF, an image), on a small page that shows it or links to it.

Claude checks the name with you before it publishes: a file's name becomes the site's,
`Pitch Deck (1).html` becomes `pitch-deck`.

## When it goes wrong

<!-- requires: sandboxUpload -->
- **Claude says its sandbox can't reach {{instance:host}}.** The files are in Claude's sandbox,
  and Claude's settings don't allow `{{instance:host}}` yet. Claude stops and publishes nothing.
  Allow it on claude.ai in a web browser,
  or on a Team or Enterprise plan ask an Owner: see [Let Claude upload its
  files](/guide/start/claude-uploads). Then tell Claude "Done, try again".
<!-- /requires -->
- **Claude can't find the file.** Give its full path, or ask Claude which recent files it can see.
  If your downloads go somewhere other than `Downloads`, change the extension's **Downloads
  folder** setting in **Settings → Extensions**.
- **Claude says you aren't signed in.** It opens the sign-in page; finish signing in in your
  browser, then ask again.
- **Claude says a newer Fling is out.** Update the extension: download it again and open it, or run
  `fling setup` if you have the CLI.
- **Something else doesn't work.** Ask Claude to "check my Fling setup": it runs the same checks as
  `fling doctor` and tells you the fixes.

## Good to know

- The extension runs on macOS and Windows.
<!-- requires: servers -->
- The extension can publish a [site server](/guide/servers/what-is-a-site-server) that is already
  one file, `_fling/server.mjs`, with no npm packages. A `server.ts`, or any server that needs
  bundling, is published with the [CLI](/guide/start/cli).
<!-- /requires -->
- One extension serves every Fling. Installing it from another Fling updates it and adds that
  Fling; with several, Claude agrees with you which one to use and says so.
- It shares its sign-ins with the CLI: sign in once, from either, and both work.
