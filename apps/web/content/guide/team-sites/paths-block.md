---
title: The Paths block
part: team-sites
order: 20
summary: A team site's home page that lists its Paths, kept up to date by Fling.
requires: [paths]
sources: [packages/shared/src/paths-index.ts, packages/shared/src/paths-templates.ts, apps/api/src/paths.ts, apps/api/src/rendering.ts, apps/cli/src/commands/paths.ts, packages/shared/src/mcp-tools.ts]
verified: 60d6113
---

A team site's home page can list its [Paths](/guide/team-sites/paths), newest first, with a search
box and a sort order. {{instance:name}} fills the list in and updates it whenever a Path is
published, archived or deleted. You never edit it by hand.

There are three ways to have a home page on a site with Paths:

- **The default.** A site with no `index.html` of its own lists its Paths. A site whose first
  publish is a Path gets this page. There is nothing to do.
- **Your own page.** Publish an `index.html` with a Paths block where the list should go.
- **No list.** An `index.html` without a Paths block lists nothing. When a site has two or more
  Paths and its home page doesn't list them, publishing says so.

## In your assistant

- "Make a home page for `payments-plans` that lists the plans as cards."
- "Give `payments-plans` a docs-style home page titled Payments docs."

The assistant starts from a template, adapts it to your wording and look, checks the block, and
publishes it as the site's home page.

## On the command line

Start from a template, check it, then publish the folder as the site's root (without `--path`):

```sh
fling paths init ./home --template plans --title "Payments plans"
fling paths check ./home
fling deploy ./home --name payments-plans
```

The templates are `plans` (a card per ticket, newest first), `docs` (sections, A to Z), `reports`
(by date, newest first) and `minimal` (a plain page with the default list). `fling paths init`
never replaces an existing `index.html` unless you add `--force`. `fling paths check` lists errors
and warnings; it fails only when there is no block.

## Writing the block

The simplest block is one comment where the list should go. {{instance:name}} puts its default list
there, styled by your page:

```html
<!-- fling:paths -->
```

For your own markup, write an item between an opening and a closing marker. It repeats once per
Path. What follows `<!-- fling:empty -->` shows when there are no Paths:

```html
<ul>
<!-- fling:paths sort=folder -->
  <li><a href="{{href}}">{{title}}</a> <time datetime="{{updated}}">{{date}}</time></li>
<!-- fling:empty -->
  <li>No plans yet.</li>
<!-- /fling:paths -->
</ul>
```

An item can use these placeholders:

| Placeholder | What it becomes |
|---|---|
| `{{href}}` | the link to the Path |
| `{{folder}}` | its folder, such as `PAY-412` |
| `{{title}}` | the title of its home page, or its folder when it has none |
| `{{updated}}` | when it was last published, as a machine-readable date |
| `{{date}}` | the same date for people, such as `5 Nov 2026` |
| `{{version}}` | its current version |

Keep dates as `<time datetime="{{updated}}">{{date}}</time>`: for a week they read as "2 hours ago"
or "yesterday".

Options go in the opening marker:

| Option | What it does |
|---|---|
| `sort=updated` | newest first (the default) |
| `sort=oldest` | oldest first |
| `sort=folder` | by folder, A to Z, with numbers in order (`PAY-9` before `PAY-10`) |
| `sort=folder-desc` | by folder, Z to A |
| `nocontrols` | no search box or sort menu |
| `nostyle` | none of {{instance:name}}'s styling, only yours |

The search box and sort menu go just before the list. To put them somewhere else, write
`<!-- fling:paths-controls -->` there.

## The list as data

A site whose home page lists its Paths also serves the same list as JSON at
`{{instance:site:payments-plans}}/_fling-paths.json`, in the block's order: each Path's `folder`,
`title`, `updated` and `version`. Whoever can open the site can read it.

## When it goes wrong

- **"No Paths block"**: the page has no `<!-- fling:paths -->`. Add one where the list should go.
- **"The template is not closed"**: add `<!-- /fling:paths -->` after the item. Until then, the
  default list is used.
- **"Unknown placeholder"**: only the placeholders above are filled in. Anything else is left as
  written.
- **"The template item has no link to its Path"**: add `<a href="{{href}}">` to the item.
- **"More than one Paths block"**: only the first is filled in.
- **The home page shows no Paths** (`paths_index_missing`): its `index.html` has no block. Add one,
  or publish the site without an `index.html` to use the default list.

## Good to know

- Only live Paths are listed: archived ones and ones not yet published are left out.
- The list is part of the page as published, so it works without JavaScript. The search, sort and
  "2 hours ago" dates need it.
