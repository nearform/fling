---
title: Claude Code
part: start
order: 40
summary: Add the Fling plugin to Claude Code, so it can publish your builds and pages.
sources: [plugin/**, .claude-plugin/**, apps/cli/src/claude.ts, apps/cli/src/commands/setup.ts, apps/cli/src/mcp.ts, apps/web/src/pages/GetStarted.tsx]
verified: 60d6113
---

The Fling plugin teaches Claude Code how to publish with {{instance:name}}: build the project,
fling the output folder, and give you the link. Say "fling the dist folder and give me a share
link" and it does the rest.

The plugin brings a `fling` skill and the Fling tools. It shares its sign-in with the
[CLI](/guide/start/cli), so you sign in once.

## Install it

The quickest way is from a terminal, with the CLI:

```sh
fling setup {{instance:origin}}
```

`fling setup` signs you in, then offers to add the plugin to Claude Code (and the extension to
Claude Desktop). Answer yes. Add `--scope project` to install the plugin for the project you are in
only.

Or add it by hand, inside Claude Code:

```
/plugin marketplace add {{fact:repo-slug}}
/plugin install fling@fling
```

The plugin runs the Fling tools with `npx`, so it needs Node.js {{fact:node-version}} or later.
Restart Claude Code, or run `/reload-plugins`, to pick it up.

## In your assistant

Ask in your own words:

- "Build this and fling it as my-app"
- "Fling the dist folder and give me a share link"
- "Fling this report as q3-report, open to everyone signed in"
- "Roll my-app back to yesterday's version"

Claude checks the name with you before it publishes a new site, and asks who should be able to
open it. It gives you back the site's address and, where your Fling has comments, a review link to
share for feedback.

If you aren't signed in, Claude opens your browser to sign in to {{instance:name}}, then carries
on.

## When it goes wrong

- **Claude doesn't use Fling.** Check the plugin is installed and enabled with `/plugin`, then
  restart Claude Code.
- **Claude says a newer Fling is out.** Update the CLI and the plugin together:

  ```sh
  npm i -g {{fact:cli-package}}@latest && fling setup
  ```

  Then restart Claude Code.
- **Something else doesn't work.** Ask Claude to "check my Fling setup", or run `fling doctor`. Both
  check the CLI, your sign-in, the plugin and the extension, and give the fix for each problem.

## Good to know

- `fling setup` run again refreshes an installed plugin to the latest version.
- With several Flings, Claude agrees with you at the start which one to use, and names it on
  every link it gives you. See [The CLI](/guide/start/cli#several-flings).
