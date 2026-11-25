---
title: Routes
part: admin
order: 28
summary: See how full the route table is, choose the format its entries are written in, and how long maintenance takes to go round every site.
audience: admin
sources: [apps/web/src/pages/AdminRoutes.tsx, apps/web/src/lib/headroom.ts, apps/api/src/route-format.ts, apps/api/src/maintenance.ts]
verified: 0a10243
---

Every site's address finds its files through the **route table**, which the edge reads on every
request. Where {{instance:name}} keeps it in a store with a size limit, it can fill up, and a site
can't go live once it has.

## In the web app

Open **Admin → Routes**.

**Usage** shows how much of the store is used, where it has a limit, and warns from 70%. Where the
store counts its entries, it also says what one takes on average and about how many more fit at
that size. Each live site has an entry, as does each live Path and share link. Where the store has
no limit, it says so.

**Format** shows how the entries are written, who chose it and when. It is **JSON** until you
choose otherwise. **Compact** takes about a third of the room.

To change it, choose **Switch to Compact** (or **Switch to JSON**) and confirm. Sites published
from then on take the new format at once; the others are rewritten in the background over the
next maintenance runs, and the page shows how many are done. Sites keep working throughout. The
choice is recorded on [Audit](/guide/admin/audit).

**Maintenance** shows maintenance's last lap of every site: how many sites, how long the work took,
in how many runs, and when it finished. Maintenance runs every 15 minutes, so a lap done in one run
means no site waits longer than that; each extra run a lap takes adds 15 minutes. From the last
lap's pace, it says about how many sites one run gets through, so you can see how far the instance
is from needing a second. Every site is maintained at least once a lap, so a lap's length is how
long a site can wait for a change such as a new version retention to reach it. Until maintenance
has finished its first lap, the page says so.

> **Warning** Before whoever runs {{instance:name}} rolls it back to an older release, switch back
> to JSON and wait until the page says the rewrite has finished. Older releases read only JSON.

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| The route table is nearly full | The instance has a lot of sites, Paths or share links for its route store. | Switch to Compact; if it is compact already, archive sites and Paths nobody uses (archived ones have no entry), or ask whoever runs {{instance:name}}, who can also lower how many live Paths a site may have. |
| The rewrite's count doesn't move | Maintenance runs every 15 minutes, and does a share of the sites each time. | Wait for the next runs. If it still doesn't move, ask whoever runs {{instance:name}} to check maintenance's logs. |
| "This page is for the instance's admins." | Your address isn't one of the instance's admins. | Ask whoever runs {{instance:name}}. |
