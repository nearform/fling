---
title: Archive or delete a site
part: publish
order: 70
summary: Take a site offline and keep it, or delete it and free its name.
sources: [apps/api/src/sites.ts, apps/api/src/publication.ts, apps/cli/src/commands/sites.ts, apps/web/src/components/site/SiteDangerZone.tsx, apps/web/src/pages/Sites.tsx, apps/web/src/lib/site-tabs.ts, packages/shared/src/deletion.ts]
verified: b4d7792
---

When a site has done its job, you can take it away in two ways.
<!-- requires: archive -->
**Archiving** takes it offline but keeps everything, so you can bring it back.
<!-- /requires -->
**Deleting** takes it offline and frees its name for anyone.
<!-- requires: recoverableDeletes -->
{{instance:name}} keeps a deleted site's files, so an admin can restore it. You can't undo a
delete yourself.
<!-- /requires -->
The question before a delete says whether an admin can recover it, or whether it is gone for good.

Only a site's owners can archive or delete it.

<!-- requires: archive -->
| | Archive | Delete |
|---|---|---|
| The address and share link | Show a 404 | Stop working |
| Files and versions | Kept | Kept for an admin to restore, or gone for good |
| The name | Still yours | Free for anyone |
| Undo | Unarchive it | Only an admin, where the files are kept |

Prefer archiving unless you need the name back or the files gone.
<!-- /requires -->

## In your assistant

<!-- requires: archive -->
- "Archive q3-report"
- "Which of my sites haven't changed in months? Archive them"
- "Bring q3-report back"
<!-- /requires -->
- "Delete old-prototype"

Your assistant deletes a site only after you have confirmed it, and tells you first whether an
admin could recover it.

## On the command line

<!-- requires: archive -->
```sh
fling archive q3-report          # offline, kept
fling unarchive q3-report        # back online
fling ls --archived              # your archived sites
```
<!-- /requires -->

```sh
fling rm old-prototype           # asks first; --yes skips the question
```

## In the web app

Open the site from **Sites** and choose its **Settings** tab, with the **Danger zone**.

<!-- requires: archive -->
- **Archive…** asks you to confirm, then takes the site offline. It moves to the **Archived** tab
  of **Sites**, where its page has **Unarchive**.
<!-- /requires -->
- **Delete…** says whether an admin can recover the site, asks you to type its name, then
  **Delete** (or **Delete for good**, where nothing is kept).

## When it goes wrong

- **There is no Settings tab on the site's page.** You publish the site but don't own it. Ask one
  of its owners: see [Owners and publishers](/guide/share/owners-and-publishers).
<!-- requires: archive -->
- **`owner_only` when you publish.** The site is archived, and only an owner can bring it back.
  An owner who publishes to it, or unarchives it, puts it back online.
<!-- /requires -->
- **You deleted the wrong site.**<!-- requires: recoverableDeletes --> Ask one of {{instance:name}}'s admins to
  restore it. If someone has taken the name since, it comes back under
  another.<!-- /requires --> If the delete was for good and you still have the files, publish them
  again under the same name, if nobody has taken it since.

## Good to know

- Deleting a site deletes its Paths, versions<!-- requires: metrics -->, [metrics](/guide/publish/metrics)<!-- /requires --> and share link too<!-- requires: servers -->, and its server and secrets. Its server's logs can no longer be read,
  and are gone within {{fact:server-log-days}}<!-- /requires -->.
<!-- requires: recoverableDeletes -->
- An admin's restore brings back the site's Paths, versions, comments and form responses, and who
  could open it. Its share link isn't restored, and its server's secrets must be set again.
<!-- /requires -->
<!-- requires: archive -->
- While a site is archived, nobody can roll it back from the web app: unarchive it first.
<!-- /requires -->
