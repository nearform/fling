---
title: Usage
part: admin
order: 22
summary: How much every site is viewed and pushed to, which sites are busy, and which have gone quiet.
audience: admin
requires: [metrics]
sources: [apps/web/src/pages/AdminUsage.tsx, apps/web/src/components/usage/**, apps/web/src/lib/usage.ts, apps/web/src/components/AdminSiteCard.tsx, apps/api/src/routes/admin.ts, apps/api/src/views.ts, apps/api/src/maintenance.ts, packages/shared/src/metrics.ts, packages/shared/src/deletion.ts]
verified: 0a10243
---

The **Usage** page shows how much {{instance:name}} is used: every site's
<!-- requires: viewCounts -->views and <!-- /requires -->pushes added together, how many sites
are in use, the busiest ones and the ones nobody has touched in a while. Use it to see whether
people are getting value from {{instance:name}}, and to find sites that may be ready to archive.<!-- requires: archivePolicy --> The [archive
policy](/guide/admin/archive-policy) can archive them for you.<!-- /requires -->

It shows counts only. {{instance:name}} keeps nothing about who opened a site, so there is nobody
to name.

## In the web app

Open **Admin → Usage**.

### Activity

At the top are the totals for the last {{fact:metric-days}}, with the last
{{fact:metric-months}} beneath each:

<!-- requires: viewCounts -->
- **Views**: each time a page of any site loaded in a browser. See
  [What counts as a view](/guide/publish/metrics#what-counts-as-a-view).
<!-- /requires -->
- **Pushes**: each time a version of any site went live, published or rolled back to.

Below them, a line follows each of the last {{fact:metric-days}}, with the busiest day marked.
<!-- requires: viewCounts -->The dots along its foot are the pushes, bigger on days with more.
<!-- /requires -->Point at the chart, or select it and use the arrow keys, to read any day.

**Last {{fact:metric-days}}** lays the same days out as a calendar, a column a week, each day
darker the busier it was. **Last {{fact:metric-months}}** has a bar a month, this month last and
so far. Open **The numbers** for every day and month as a table. Days are UTC days.

<!-- requires: viewCounts -->
### How lively the sites are

Rings show how many of the live sites (published and not archived) were viewed in the last 90,
28 and 7 days, outermost first, each as full as its share. Beside them are the counts and
shares, how many live sites have never been viewed, and how many sites there are in all.

### Most viewed

The live sites with the most views over the last {{fact:metric-days}}, busiest first. The bars
compare each with the first. Choose a name to open its site page.
<!-- /requires -->

### Gathering dust

The live sites unused for longest, a week or more, with how long it has been: since a view or a
push, whichever was later, or since the site last changed if it has had neither. The longer a site
has been left, the fainter its name. Choose a name to open its site page, where you can archive it.

### Deleted sites

How many deleted sites<!-- requires: paths --> and Paths deleted on their own<!-- /requires --> are kept,
and about how much they take: a guide, from the sizes of their versions. **See and restore them**
opens [Deleted sites](/guide/admin/deleted).

### Where the site numbers come from

The totals and the charts above them are counted as views and pushes happen. Everything about the sites
themselves is tallied by maintenance as it goes round every site, so it is as fresh as its last
full lap: the page says **As of** when that lap finished. How long a lap takes is on
[Routes](/guide/admin/routes).

## Turn view counting on or off
<!-- requires: viewCounts -->
**View counting**, at the bottom of the page, says whether the sites' pages count views. It is on
unless an admin has turned it off.

- **Turn off for every site** takes the small script that reports a view off every site's pages
  and stops counting. The views counted so far stay, on this page and on each site's page, and
  pushes are still counted.
- **Turn on for every site** puts it back on every live site. Sites don't need publishing again,
  and their owners see no new version.

Either way, maintenance goes round every site to apply the change, and the section says how far
it has got. It is in the audit log as who turned view counting on or off. Only an admin signed in
to the web app can use the switch: an API key can't.

A page someone already has open can still report a view after counting is turned off. It isn't
counted.
<!-- /requires -->
<!-- requires: viewCounts, archivePolicy -->
While view counting is off, the [archive policy](/guide/admin/archive-policy) warns, archives and deletes nothing: it
can't tell a site nobody viewed from one whose views weren't counted. Once it is back on, the
policy waits until views have been counted for its whole wait again.
<!-- /requires -->

## In All sites

<!-- requires: viewCounts -->
On **Sites → All sites**, each site shows **Last viewed**: how long ago one of its pages was last
opened, or **—** if it never has. Point at it for the date and time.
<!-- /requires -->

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| **Maintenance hasn't been round every site yet** | Its first lap isn't over. | Wait: the site numbers appear when it ends. |
| **Some sites are missing from these numbers** | The last lap began before tallying did. | Wait for the next lap, which counts every site. |
| **The site tallies come from maintenance's sweep … which is off** | Whoever runs {{instance:name}} has turned the sweep off with `MAINTENANCE_SWEEP_ENABLED`. | Ask them to turn it on. The totals and charts work without it. |
| **{{instance:name}} doesn't count views** | Whoever runs {{instance:name}} has turned view counts off (`SITE_VIEW_COUNTS`), which also removes the switch. | The page shows pushes only. Ask them to turn view counts on. |
| **View counting is off** | An admin turned it off with the switch. | The views shown are those counted before. Turn it on again to count new ones. |
| **All quiet so far** | Nothing has been viewed or pushed in the last {{fact:metric-months}}. | Nothing: the charts fill in as sites are used. |

## Good to know

- The site numbers are a guide, not a ledger: a site's views can change while maintenance is
  partway round.
- Only live sites are ranked. Archived sites and sites never published count towards the total
  of sites and nothing else.
- Today's count is today so far.
