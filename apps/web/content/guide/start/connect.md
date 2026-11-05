---
title: Connect Claude, ChatGPT or Gemini
part: start
order: 20
summary: Add your Fling as a connector, so your assistant can publish what it makes for you.
requires: [remoteMcp]
sources: [apps/api/src/config.ts, apps/api/src/mcp/**, apps/api/src/oauth/**, packages/shared/src/mcp-tools.ts, apps/web/src/pages/GetStarted.tsx, apps/web/src/pages/ApiKeys.tsx, apps/web/src/pages/Authorize.tsx]
verified: 998e984
---

Connect {{instance:name}} to your assistant once, and it can publish the pages, reports and
prototypes it makes for you, then hand you the link. It signs in as you, so the sites it makes are
yours and private until you say otherwise.

Nothing to install: the connector is an address, `{{instance:mcp}}`.

## In your assistant

**In Claude** (the desktop app, the web or mobile):

1. Open **Settings → Connectors → Add custom connector**.
2. Paste `{{instance:mcp}}` as its URL, then click **Connect**.
3. Your browser opens {{instance:name}}. Sign in with {{instance:account}}, check what Claude asks
   to do, and click **Allow**.

On a Team or Enterprise plan, an Owner can add the connector once for the whole organisation.
Everyone else then only clicks **Connect** and signs in.

**In ChatGPT**, add `{{instance:mcp}}` as a custom connector (an app) from its settings. ChatGPT
only offers custom connectors with developer mode turned on, and the names of its menus change, so
follow its own help for where to find them. You sign in and click **Allow** the same way.

**In Gemini** (gemini.google.com), open **Settings → Connected Apps → Add a custom app**, paste
`{{instance:mcp}}`, then sign in and click **Allow**. Once added, it works in the Gemini mobile app
too.

**In Cursor, VS Code, Gemini CLI or Codex**, add `{{instance:mcp}}` as a remote MCP server in its
settings; it opens your browser to sign in the first time.

Then ask for what you want:

- "Fling this page as q3-report"
- "Make a one-page summary of this doc and fling it, private"
- "Give me a share link for q3-report"
- "Which of my Fling sites can I archive?"

Your assistant sends the files it made straight to {{instance:name}}: up to {{fact:max-inline}} in
one go, and bigger sites in parts. It gives you back the site's address and, where your Fling has
comments, a review link to share for feedback.

## In the web app

**Connections** lists every app you allowed, under **Connected apps**, with when each was last used.
Click **Revoke**, then **Disconnect**, to disconnect one: it is signed out at once. Connect it again whenever you like.

## When it goes wrong

- **The assistant can't reach your files.** A connector sees only what is in the conversation. To
  publish a file or folder on your computer, use the [Claude Desktop
  extension](/guide/start/claude-desktop), the [Claude Code plugin](/guide/start/claude-code) or
  the [command line](/guide/start/cli).
- **Connecting fails before you see the sign-in page.** Each Fling accepts the assistants its
  operators allowed: Claude, ChatGPT, Gemini, Cursor and the assistants on your own computer,
  unless they changed that. If yours can't connect, ask whoever runs {{instance:name}}.
- **Your assistant says it isn't signed in.** You revoked it, or its sign-in expired. Connect it
  again from the connector's settings.
- **The name is taken.** Site names are first come, first served. Your assistant shows free names
  to pick from: see [Site names](/guide/publish/names).

## Good to know

- The assistant asks you before it publishes under a new name, and before it deletes anything.
- What it can do is what you can do: it never sees a site you can't open.
