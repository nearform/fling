# The Guide's voice

How every page of the Guide is written. Not a page itself: the reader never sees this file.

## Who reads it

Someone who has heard of Fling and wants to get something done: publish a page, share it, collect
feedback. Often not a developer. They may arrive from a link in a chat, signed out. Admins and
whoever runs the instance read their own parts.

## The shape of a page

1. **What it is and why** — two or three sentences, before any heading. What the feature does for
   the reader, not how it is built.
2. **The routes, one section each, in this order, only those that apply:**
   - `## In Claude or ChatGPT` — what to ask, as example prompts in quotes. The assistant does the
     rest through the connector, the Desktop extension or the Claude Code plugin.
   - `## On the command line` — the commands, each in a fenced `sh` block the reader can copy.
   - `## In the web app` — where to click: name the page and the button as they appear.
3. **`## When it goes wrong`** — the errors people hit, what each means, what to do.
4. Optional `## Good to know` — limits and edge cases, briefly.

A page is one task or one idea. If it needs more than five sections, split it.

## Rules

- **British English**, plain and direct: behaviour, colour, organisation. Second person ("you").
  Short sentences. No marketing; the why-fling deck does that.
- **Describe what Fling does today.** No "soon", "new", "previously". History is the CHANGELOG's.
- **Nothing instance-specific is written down.** Use the placeholders, which each instance fills
  in: `{{instance:origin}}` (its address), `{{instance:name}}`, `{{instance:mcp}}` (the connector
  URL), `{{instance:install}}` (the install command), `{{instance:sites}}` (the sites' domain),
  `{{instance:site:my-app}}` (a site's URL), `{{instance:account}}` ("your Example account"),
  `{{instance:audience}}` (who a private site is open to).
- **Numbers and names the code owns are facts**: `{{fact:max-deploy}}`, `{{fact:cli-package}}`…
  (`packages/shared/src/guide-facts.ts`). Never type a limit into prose; add a fact.
- **Features an instance can switch off** are gated: the whole page with `requires:` in its
  frontmatter, a passage with `<!-- requires: forms -->…<!-- /requires -->`.
- **Link to other pages** with their address, `/guide/<part>/<page>`, and `#section` ids as the
  headings make them (lower case, spaces to `-`).
- **Name what the reader sees**: a command, a flag, a button, a page. Never a file or line of
  Fling's code; the reader has no use for it.
- **Examples are invented and obviously so**: `my-app`, `q3-report`, `PAY-412`,
  `ana@example.com`. Never a real person, client or site.
- Callouts: a blockquote that opens with `**Note**`, `**Tip**` or `**Warning**`. Use them rarely.

## Frontmatter

```yaml
---
title: Versions and rollback
part: publish            # the directory it lives in
order: 60                # its place within the part (leave gaps)
summary: Every publish is kept; put an earlier one back.
requires: [rollback]     # optional: capabilities the page needs
audience: admin          # optional: admins only
sources: [apps/api/src/publication.ts, apps/cli/src/commands/rollback.ts]
verified: 0123abc        # the commit you last checked it against its sources at
---
```

`sources` are coarse globs of the code the page describes. When that code changes, the Stop hook
and `node scripts/docs-stale.mjs` flag the page; `/doc-sync` brings it back in line and moves
`verified` on.
