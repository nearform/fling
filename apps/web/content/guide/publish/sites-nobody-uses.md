---
title: Sites nobody uses
part: publish
order: 75
summary: Sites nobody views or publishes to are archived after a warning; keep the ones you need.
requires: [archivePolicy]
sources: [apps/api/src/archive-policy.ts, apps/api/src/sites.ts, apps/cli/src/commands/sites.ts, apps/cli/src/archive-policy.ts, apps/web/src/components/site/SiteDangerZone.tsx, apps/web/src/components/site/SiteArchiveNotice.tsx, apps/web/src/components/site/badges.tsx, packages/shared/src/archive-policy.ts, packages/shared/src/mcp-tools.ts]
verified: 0a10243
---

{{instance:name}} archives a published site that nobody has viewed or published to for a while,
so old sites don't pile up. You are always told first, and you can **keep** a site you still need
so it is never archived for disuse. An archived site keeps its name, files and versions, and comes
back when you unarchive it or publish to it.

## In your assistant

- "Keep q3-report from being archived"
- "Is q3-report going to be archived?"
- "Stop keeping old-prototype"
- "Bring q3-report back"

Your assistant keeps a site only if you own it. To keep someone else's site, ask one of its owners.

## On the command line

```sh
fling keep q3-report             # never archived for disuse
fling keep q3-report --off       # archived like any site again, once nobody uses it
fling info q3-report             # its Archiving line: kept, or when it will be archived
fling unarchive q3-report        # back online after the policy archived it
```

## In the web app

You are told before anything happens:

<!-- requires: email -->
- **By email**, to every owner, some days before, with the date. Turn it off under **Your sites**
  in [Notifications](/guide/feedback/notifications); the site is archived on that date all the same.
<!-- /requires -->
- **On the site's page**, for its owners and publishers: *Will be archived on …, unless someone
  views or publishes it first, or an owner keeps it*. Until its owners have been told, the date is
  *at the earliest*.

To keep the site online, do one of these before the date:

- **View it or publish to it.** The wait starts again.
- **Keep it.** Open the site from **Sites**, choose its **Settings** tab, and turn on **Keep: exempt
  from the archive policy** in the **Danger zone**. **Keep it** in the notice opens the same
  switch. A kept site is never archived for disuse, and it wears a **Kept** badge. Its owners can
  keep it, and so can an admin, from the site's page.

An archived site's page says *Archived by the archive policy on …*. Unarchive it, or publish to it,
and it is back online at once, as after any archive.

Where {{instance:name}} also deletes what it archived, a site the policy archived is deleted some
time later, after its owners are told the same way (*Will be deleted on …*). Unarchive it or keep
it to stop the delete. The policy never deletes a site that you or an admin archived.

## When it goes wrong

- **"Only the owners of q3-report can keep it".** You publish the site but don't own it. Ask one of
  its owners: see [Owners and publishers](/guide/share/owners-and-publishers).
- **A site you still need was archived.** Unarchive it, or publish to it, then keep it.
- **A site the policy deleted is still needed.**<!-- requires: recoverableDeletes --> Ask one of
  {{instance:name}}'s admins to restore it. It comes back archived, as if you had archived it, and
  the policy never deletes it again: unarchive it to put it back online.<!-- /requires -->
  If the delete was for good and you still have the files, publish them again.

## Good to know

- A site counts as used when one of its pages is viewed, when someone publishes to it, and when it
  is unarchived. A new site counts from when it was made.
- The policy archives whole sites: a site's Paths go offline with it, and come back with it.
- A site with nothing published is never archived.
- For archiving and deleting by hand, see [Archive or delete a site](/guide/publish/archive-and-delete).
