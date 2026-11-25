---
title: Archive policy
part: admin
order: 23
summary: Archive the sites nobody uses, delete what it archived, purge deleted sites: dry run first, owners always warned.
audience: admin
sources: [apps/web/src/pages/AdminArchivePolicy.tsx, apps/web/src/lib/archive-policy.ts, apps/api/src/archive-policy.ts, packages/shared/src/archive-policy.ts, apps/api/src/config.ts, apps/api/src/maintenance.ts, apps/cli/src/commands/admin.ts, apps/cli/src/archive-policy.ts]
verified: 0a10243
---

The archive policy tidies {{instance:name}} for you. It archives the sites nobody has viewed or
published for a while, can delete the ones it archived some time later, and can delete for good
what deleted sites left behind. Whoever runs {{instance:name}} turns it on and chooses how long
each step waits. It starts in **dry run**, where it only shows what it would do. Nothing happens
to anyone's site until an admin turns it **live**, and even then a site's owners are always
warned before it is archived or deleted.

<!-- requires: archivePolicy -->
## In your assistant

- "Is the archive policy on, and is it live?"
- "What will the archive policy do this week?"
- "What has the archive policy archived lately?"

Your assistant reads the policy and links to **Admin → Archive policy**. It can't turn the policy
live or back to dry run: only you can, there.
<!-- /requires -->

## On the command line

```sh
fling admin archive-policy    # the settings, dry run or live, why it is paused, the next {{fact:archive-preview-days}}, what it did lately
```

It ends with the link to **Admin → Archive policy**, where you switch it. Add `--json` for the
whole status.

## In the web app

Open **Admin → Archive policy**. Where nothing of the policy is set, the page says **Off** and
lists the four settings that turn it on.

### The settings

Whoever runs {{instance:name}} sets four numbers of days in its config. 0 turns a step off; the
warning must be at least 1 while archiving is on. All but the warning are 0 unless set, so the policy is off until someone turns it on. Changing one is a
deploy. The page lists them under **Settings**, with what they make the policy do.

| Setting | What it does |
|---|---|
| `ARCHIVE_INACTIVE_DAYS` | Archive a published site nobody has viewed or published for this long. |
| `ARCHIVE_WARN_DAYS` | Warn a site's owners this long before it is archived or deleted. |
| `DELETE_ARCHIVED_DAYS` | Delete a site the policy archived this long after it did. Never a site its owners or an admin archived. |
| `PURGE_DELETED_DAYS` | Delete for good what a deleted site left behind, this long after the delete, whoever deleted it. |

A site counts as used when one of its pages is viewed, when someone publishes to it, and when it
is unarchived. A new site counts from when it was made.

<!-- requires: email -->
A site the policy deletes is deleted as an owner's delete would be: kept for an admin to restore,
unless {{instance:name}} deletes for good.
<!-- /requires -->
Where {{instance:name}} sends no email, the policy archives but never deletes. The site page is the
only warning there, and the owners of an archived site may not look at its page again in time.

### Dry run, then live

**State** says **Dry run** or **Live**, and who last switched it and when.

- In **dry run** the policy works out what it would do and does none of it: no warning, no
  archive, no delete, no email.
- **Turn live…** says who will be warned and how soon anything can happen, and asks you to confirm.
  From then on it warns, archives, deletes and purges as set.
- **Back to dry run…** stops it again. What it did stays done, but the warnings it gave no longer
  hold: when it is live again, it warns the owners again before anything is archived or deleted.

Only an admin signed in to the web app can switch it: an API key or an assistant can't. Each switch
is recorded on [Audit](/guide/admin/audit).

### Warned first

Nothing is archived or deleted unless its owners were warned at least `ARCHIVE_WARN_DAYS` before,
while the policy was live, and it has stayed live since. So turning it live never archives or
deletes a site at once: the sites already overdue are warned first, and archived no sooner than
`ARCHIVE_WARN_DAYS` later. A warning also holds only while nothing happens to the site. If someone views it, publishes to it or unarchives it, the
wait starts again, and so does the warning. An owner who keeps the site takes the warning back.

### Paused

A site nobody viewed can't be told from one whose views nobody counted, so the policy pauses while
views aren't counted. A banner at the top says why:

<!-- requires: viewCounts -->
- **View counting is turned off** on [Admin → Usage](/guide/admin/usage#turn-view-counting-on-or-off).
<!-- /requires -->
- **Views have been counted for too short a time**: once counting is on, the policy waits until
  views have been counted for `ARCHIVE_INACTIVE_DAYS` without a break, and the banner gives the
  date.
- **This Fling counts no views**: whoever runs it has turned view counts off (`SITE_VIEW_COUNTS`).

While paused it warns, archives and deletes nothing. Purging goes on.

### The next {{fact:archive-preview-days}}

The preview lists what the policy would do (in dry run) or will do (live) in the next
{{fact:archive-preview-days}}, soonest first:

- **Sites**: each site, its owner, the step (warn its owners it will be archived, archive, warn its
  owners it will be deleted, delete) and when: **Now**, or a date.
- **Deleted sites purged for good**: each deleted site or Path, when it was deleted, and when it
  will be purged.

Use the dry run to read the list before turning it live. A site appears once the policy has looked
at it, as it goes round every site in the background, so it can take a while after the policy is
turned on for the list to fill. Kept sites never appear. When there is more due than the lists
hold, the page says so and shows the soonest.

**Recent actions** lists what the policy did lately, newest first: archived, deleted, deleted for
good.

<!-- requires: archivePolicy -->
### Keep

A site's owners can exempt it with **Keep**, in the **Danger zone** of its **Settings** tab, or with
`fling keep`. A kept site is never warned of, archived or deleted by the policy, and once deleted it
is never purged by it. It wears a **Kept** badge. You can keep anyone's site from its page, signed
in to the web app. See [Sites nobody uses](/guide/publish/sites-nobody-uses).

### What owners get

<!-- /requires -->
<!-- requires: archivePolicy, email -->
- An email, **Your site is about to be archived** (or **Your archived site is about to be
  deleted**), with the date. It goes to every owner, the members of an owner group included. It is
  under **Your sites** in each person's [Notifications](/guide/feedback/notifications), where they
  can turn it off; the policy goes ahead all the same.
<!-- /requires -->
<!-- requires: archivePolicy -->
- On the site's page, for its owners and publishers: **Will be archived on …** (or **Will be
  deleted on …**), with **at the earliest** until its owners have been warned.
- Once it is archived: **Archived by the archive policy on …**. Unarchiving it, or publishing to
  it, brings it back.
<!-- /requires -->

### Purging and Admin → Deleted

`PURGE_DELETED_DAYS` does what **Delete for good…** on [Admin → Deleted](/guide/admin/deleted)
does, with the same checks: it never purges a site that is live again or one being restored. It
purges the oldest first, a few each time it runs, and tells nobody first. Until a deleted site's
purge, you can still restore it from **Admin → Deleted**. A site the policy deleted comes back
archived, as if its owners had archived it, so the policy never deletes it again.

Everything the policy does is on [Audit](/guide/admin/audit), done by **The archive policy**. On
**Admin → Deleted**, a site it deleted shows `archive-policy` as who deleted it.

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| **Off**, and the four settings | Nothing of the policy is set. | Ask whoever runs {{instance:name}} to set `ARCHIVE_INACTIVE_DAYS` (or `PURGE_DELETED_DAYS`) and deploy. |
| A **Paused** banner | Views aren't counted, or haven't been for long enough. | Turn view counting on, or wait until the date the banner gives. |
| "Nothing is due." in dry run, though some sites are old | The policy hasn't looked at every site yet, or they are kept or unpublished. | Look again later. |
| "The archive policy is off on this Fling" when you switch it | Its settings were turned off since the page loaded. | Refresh the page. |
| A site was archived that someone still needs | Its owners didn't act on the warning. | An owner unarchives it, and keeps it. |
| "This page is for the instance's admins." | Your address isn't one of the instance's admins. | Ask whoever runs {{instance:name}}. |
| "Stop impersonating to get back to the admin pages." | You are acting as someone else. | Choose **Stop** in the bar at the top. |

## Good to know

- The policy archives whole sites. A site's Paths go offline with it, and come back with it.
- A site with nothing published is never archived.
