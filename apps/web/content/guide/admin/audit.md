---
title: Audit
part: admin
order: 25
summary: See what admins did: impersonations, invitations, changes to other people's sites.
audience: admin
sources: [apps/web/src/pages/AdminAudit.tsx, apps/api/src/audit.ts, apps/api/src/admin.ts]
verified: c82d9d4
---

{{instance:name}} records what admins do beyond their own sites, so that anyone who looks after
the instance can see it afterwards.

## In the web app

Open **Admin → Audit**. The newest entries come first:

- every impersonation's start and stop;
- every invitation made or revoked, and how it came about;
- what admins changed on other people's sites, and what they opened of restricted ones;<!-- requires: servers -->
- each site server published, and each viewer id an admin looked up;<!-- /requires --><!-- requires: viewCounts -->
- each time view counting was turned on or off for every site ([Usage](/guide/admin/usage#turn-view-counting-on-or-off));<!-- /requires -->
- each choice of the route table's format ([Routes](/guide/admin/routes)).

Entries are kept for {{fact:audit-days}}.

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| "This page is for the instance's admins." | Your address isn't one of the instance's admins. | Ask whoever runs {{instance:name}}. |
| "Stop impersonating to get back to the admin pages." | You are acting as someone else. | Choose **Stop** in the bar at the top. |
| Something you expected isn't there | Only what is listed above is recorded, and only for {{fact:audit-days}}. | Owners see their own sites' versions on each site's page. |
