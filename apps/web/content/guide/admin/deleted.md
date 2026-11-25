---
title: Deleted sites
part: admin
order: 24
summary: Find a deleted site or Path whose files are kept, restore it, or delete it for good.
audience: admin
sources: [apps/web/src/pages/AdminDeleted.tsx, apps/web/src/lib/deleted.ts, packages/shared/src/deletion.ts, apps/api/src/routes/admin.ts, apps/api/src/deletion.ts, apps/cli/src/commands/admin.ts, apps/cli/src/deleted.ts]
verified: b4d7792
---

When someone deletes a site or a Path, its address stops working and the name is free for anyone.
<!-- requires: recoverableDeletes -->
{{instance:name}} keeps its files, so an admin can put it back.
<!-- /requires -->
Sites kept this way stay restorable even if {{instance:name}} later switches to deleting for good.
Only an admin can restore one, or delete it for good, from the web app, signed in as themselves:
an API key or an assistant can list deleted sites but never restore or remove them.

## In your assistant

- "Which sites were deleted lately?"
- "Was q3-report deleted, and by whom?"

Your assistant lists them and links to **Admin → Deleted**, where you restore one or delete it for
good.

## On the command line

```sh
fling admin deleted              # every deleted site and Path still kept, newest first
fling admin deleted q3-report    # the ones deleted under one name
```

To restore one, or delete it for good, open the link it prints: **Admin → Deleted** in the web app.

## In the web app

Open **Admin → Deleted**. Each row is a deleted site, or a Path deleted on its own: its owner, who
deleted it and when, and about how much is kept. A site's row names the Paths deleted with it. Type
a site name in the search box to see only the deletes under that name.

Choose **Restore…** on a row:

- **A site** asks for the name to restore it as, its own to start with. Its last live version goes
  live again (a site archived before the delete comes back archived), with its Paths, older versions, comments and form responses, and the people and groups
  it was shared with. If the name has been taken since, the dialog says so and suggests free ones:
  pick one or type another.
- **A Path** goes back on its site under its own folder. Its site must exist, and the folder must be
  free.

The result gives the site's address and says:

- who was left out: people no longer on {{instance:name}} and groups that no longer exist;
- whether you became its owner, because none of its owners was left;
- whether its site server waits for secrets, and which. The static site is live at once; the server
  starts once its owner sets them on the site's **Server** tab. If the server can't start, the
  result says why.

A site comes back without its share link: its owner can [share it again](/guide/share/share-links).

Choose **Delete for good…** on a row to remove what is kept: its files and its row. A site's row
takes the Paths deleted with it. It asks you to confirm, and can't be undone. Do it for deletes
nobody will need: kept files take storage until then.

Every restore and every delete for good is recorded on [Audit](/guide/admin/audit).
<!-- requires: metrics -->
[Usage](/guide/admin/usage) counts the deleted sites kept and about how much they take.
<!-- /requires -->

## When it goes wrong

| What you see | What it means | What to do |
|---|---|---|
| The name is already taken | Someone has a live site with that name. A restore never replaces one. | Pick a suggestion, or type another name. |
| The folder is taken, or the site has no room for another Path | The site has a Path in that folder now, or as many live Paths as it may have. | Ask the site's owners to move or archive one, then restore again. |
| The site doesn't exist | A Path's site has been deleted too. | Restore the site first. |
| The delete didn't finish | Part of the site is still there. | Delete the site again, then restore it. |
| "It is being deleted for good" | Another admin is deleting it for good, or did and it stopped part way. | There is nothing to restore. **Delete for good…** again finishes it. |
| "It is being restored", when you delete it for good | A restore is under way, or one stopped part way. | Restore it again to finish, then delete the site as usual if you still want it gone. |
| "It is live again" or "still has records", when you delete it for good | It has been restored since, or its delete didn't finish. Its files are kept. | Refresh the page. If the delete didn't finish, delete the site again first. |
| The files are gone | Someone removed them from storage by hand. | There is nothing left to restore. |
| The recovery file can't be read | It was written by a release from long before, when its records had another shape. | The files are still in storage. Ask whoever runs {{instance:name}} to recover the site by hand, as their deploy guide says. |
| "This page is for the instance's admins." | Your address isn't one of the instance's admins. | Ask whoever runs {{instance:name}}. |
| "Stop impersonating to get back to the admin pages." | You are acting as someone else. | Choose **Stop** in the bar at the top. |

## Good to know

- Kept files stay in storage until they are restored or an admin deletes them for good.
  {{instance:name}} never removes them itself.
- Sizes are a guide: the total of every kept version's files.
- A Path deleted with its site comes back with the site. One deleted on its own before that has its
  own row and its own restore.
