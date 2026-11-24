---
title: How a site is doing
part: publish
order: 65
summary: A site's views and pushes by day, week and month. Counts only, never who.
requires: [metrics]
sources: [packages/shared/src/metrics.ts, packages/shared/src/view-beacon.ts, apps/api/src/views.ts, apps/api/src/rendering.ts, apps/api/src/policy.ts, apps/cli/src/stats.ts, apps/cli/src/commands/sites.ts, apps/web/src/components/site/SiteMetrics.tsx, apps/web/src/components/site/MySitesStats.tsx, apps/web/src/pages/Sites.tsx, apps/web/src/lib/metrics.ts, packages/shared/src/mcp-tools.ts]
verified: c82d9d4
---

{{instance:name}} counts how often each site changes and, <!-- requires: viewCounts -->how often
its pages are opened, <!-- /requires -->so you can tell whether anyone is using it. It keeps
counts and nothing about who: no names, no email addresses, no cookie. A site's owners and
publishers see them, and so do admins.

What it counts:

<!-- requires: viewCounts -->
- **Views**: each time one of the site's pages loads in a browser.
<!-- /requires -->
- **Pushes**: each time a version goes live, whether it was published or rolled back to.

The counts go back {{fact:metric-days}} by day, {{fact:metric-weeks}} by week and
{{fact:metric-months}} by month, with the totals over the days and over the months, and when the
site was last viewed and last pushed. Days are UTC days, and today's count is today so far.

## In your assistant

- "How is my-app doing?"
- "Has anyone looked at q3-report this week?"
- "How often has my-app changed this month?"
- "How are my sites doing overall?"

The assistant reads them with `fling_stats`; without a site's name, it adds up every live site you
own or publish. Asked who is using a site, it answers with the
numbers: there is nobody to name.

## On the command line

```sh
fling stats my-app          # totals, last viewed and pushed, and a bar a day
fling stats my-app --json   # every day, week and month, as data
fling stats                 # all your live sites together
```

## In the web app

Open the site from **Sites**. Below **Overview**, **Metrics** shows the totals for the last
{{fact:metric-days}} and {{fact:metric-months}}, when the site was last viewed and last pushed,
and a line of the last {{fact:metric-days}}, drawn as **Activity** draws it. Point at the line, or
use the arrow keys, to read a day's count.

<!-- requires: viewCounts -->
**Sites** opens with **Activity**: the views and pushes of every live site you own or publish,
added up. Folded, as it starts, it is one row: a small line of the last {{fact:metric-days}} and
their totals. Choose **Activity** to open it for the full counts and a line you can point at to
read a day; it stays open or folded as you left it, in that browser. Each of your sites in the
list has its own small line of its views over the {{fact:metric-days}}, with their total: just
before its links in a list, on a line of its own on a card. Its colour says how busy the site was
against the busiest of your sites, from faint for a quiet one to bright for the busiest, so the
sites people use most stand out. With a great many
sites, Activity adds up the ones updated last, and says so.
<!-- /requires -->

<!-- requires: viewCounts -->
## What counts as a view

A view is a page of the site loading in a browser. Each page carries a small script that tells
{{instance:name}} it was opened, and sends nothing else: no cookie, no identifier, not even which
page it was.

- A page that a browser loads ahead of time counts only once it is shown.
- The previews in the web app and the site's review page don't count, nor does a page shown in a
  frame of its own site.
- A site embedded in another site's page counts.
- A single-page app counts the first page it loads, not the pages you move to inside it.
- A page whose Content-Security-Policy blocks inline scripts doesn't count.
- A version counts views only if it was published while {{instance:name}} counts them. A version
  with more than {{fact:counted-pages-max}} HTML pages, or a page over
  {{fact:counted-page-max-size}}, counts none. Publish again to start counting.
<!-- /requires -->

## When it goes wrong

- **"No site … whose metrics you can read"**: there is no site by that name, or you aren't one
  of its owners or publishers. People who can only open the site don't see its metrics.
- **No views at all, on a site people use**: its live version may predate view counts, or be too
  large to count. Publish it again.
- **"… doesn't count views"**: whoever runs {{instance:name}} has turned view counts off. Pushes
  are still counted.

## Good to know

- **Counted since** is when the site's first count was kept. Nothing before it is known, so the
  totals cover no further back.
- Views are written every few seconds, not the moment they happen: a view can take a little while
  to show.
- Deleting a site deletes its metrics. Archiving keeps them.
- An admin can turn view counting off for every site, from Admin → Usage. The views counted
  before stay on this page, which says counting is off. Whoever runs {{instance:name}} can also
  turn view counts off with its `SITE_VIEW_COUNTS` setting. Pushes are counted either way.
