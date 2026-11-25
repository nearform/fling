---
title: Audit
part: admin
order: 25
summary: See what admins did, and the archive policy: impersonations, invitations, changes to other people's sites.
audience: admin
sources: [apps/web/src/pages/AdminAudit.tsx, apps/web/src/lib/archive-policy.ts, apps/api/src/audit.ts, apps/api/src/admin.ts, apps/api/src/archive-policy.ts]
verified: 0a10243
---

{{instance:name}} records what admins do beyond their own sites, and what its archive policy does,
so that anyone who looks after the instance can see it afterwards.

## In the web app

Open **Admin → Audit**. The newest entries come first:

- every impersonation's start and stop;
- every invitation made or revoked, and how it came about;
- what admins changed on other people's sites, and what they opened of restricted ones;<!-- requires: servers -->
- each site server published, and each viewer id an admin looked up;<!-- /requires --><!-- requires: viewCounts -->
- each time view counting was turned on or off for every site ([Usage](/guide/admin/usage#turn-view-counting-on-or-off));<!-- /requires -->
- every site and Path deleted, by anyone, its owners included, and each one an admin restored or
  deleted for good ([Deleted sites](/guide/admin/deleted));
- each choice of the route table's format ([Routes](/guide/admin/routes));
- each time an admin set the [archive policy](/guide/admin/archive-policy) live or back to dry run,
  and every site it archived, deleted or deleted for good. Those entries name **The archive
  policy** as who did it.

Entries are kept for {{fact:audit-days}}.

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| "This page is for the instance's admins." | Your address isn't one of the instance's admins. | Ask whoever runs {{instance:name}}. |
| "Stop impersonating to get back to the admin pages." | You are acting as someone else. | Choose **Stop** in the bar at the top. |
| Something you expected isn't there | Only what is listed above is recorded, and only for {{fact:audit-days}}. | Owners see their own sites' versions on each site's page. |
