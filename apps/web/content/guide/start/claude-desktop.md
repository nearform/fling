---
title: Claude Desktop
part: start
order: 30
summary: Install the Fling extension, so Claude Desktop can fling files from your computer.
sources: [apps/cli/mcpb/**, apps/cli/src/mcp.ts, apps/cli/src/mcp-entry.ts, apps/cli/src/locate.ts, apps/cli/src/commands/setup.ts, apps/web/src/pages/GetStarted.tsx]
verified: 60d6113
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

## In Claude or ChatGPT

Name the file, or describe it:

- "Fling Pitch Deck.html from my Downloads"
- "Fling the zip I just downloaded as launch-site"
- "Fling ~/work/my-app/dist as my-app"
- "Which HTML files did I download this week?"

Claude looks for a file you name, newest first, in the folder you are working in, your Downloads,
your Desktop, `Documents/Claude` and the folders where Claude Desktop and Cowork save their output.
It tells you where it found the file. Pages Claude writes in the conversation are published
directly, without a file.

What you can fling:

- **A folder**, as it is.
- **One HTML page**, served as the site's home page.
- **A zip of a site**, unpacked first.
- **Any other file** (a PDF, an image), on a small page that shows it or links to it.

Claude checks the name with you before it publishes: a file's name becomes the site's,
`Pitch Deck (1).html` becomes `pitch-deck`.

## When it goes wrong

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
- One extension serves every Fling. Installing it from another Fling updates it and adds that
  Fling; with several, Claude agrees with you which one to use and says so.
- It shares its sign-ins with the CLI: sign in once, from either, and both work.
