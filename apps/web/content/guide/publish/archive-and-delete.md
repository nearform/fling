---
title: Archive or delete a site
part: publish
order: 70
summary: Take a site offline and keep it, or remove it for good.
sources: [apps/api/src/sites.ts, apps/api/src/publication.ts, apps/cli/src/commands/sites.ts, apps/web/src/components/site/SiteDangerZone.tsx, apps/web/src/pages/Sites.tsx]
verified: 60d6113
---

When a site has done its job, you can take it away in two ways.
<!-- requires: archive -->
**Archiving** takes it offline but keeps everything, so you can bring it back.
<!-- /requires -->
**Deleting** removes it and every version for good, and frees its name for anyone.

Only a site's owners can archive or delete it.

<!-- requires: archive -->
| | Archive | Delete |
|---|---|---|
| The address and share link | Show a 404 | Stop working |
| Files and versions | Kept | Gone |
| The name | Still yours | Free for anyone |
| Undo | Unarchive it | Not possible |

Prefer archiving unless you need the name back or the files gone.
<!-- /requires -->

## In your assistant

<!-- requires: archive -->
- "Archive q3-report"
- "Which of my sites haven't changed in months? Archive them"
- "Bring q3-report back"
<!-- /requires -->
- "Delete old-prototype for good"

Your assistant deletes a site only after you have confirmed it.

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

Open the site from **Sites** and scroll to **Danger zone**.

<!-- requires: archive -->
- **Archive…** asks you to confirm, then takes the site offline. It moves to the **Archived** tab
  of **Sites**, where its page has **Unarchive**.
<!-- /requires -->
- **Delete…** asks you to type the site's name, then **Delete for good**.

## When it goes wrong

- **There is no Danger zone on the site's page.** You publish the site but don't own it. Ask one
  of its owners: see [Owners and publishers](/guide/share/owners-and-publishers).
<!-- requires: archive -->
- **`owner_only` when you publish.** The site is archived, and only an owner can bring it back.
  An owner who publishes to it, or unarchives it, puts it back online.
<!-- /requires -->
- **You deleted the wrong site.** It can't be recovered. If you still have the files, publish them
  again under the same name, if nobody has taken it since.

## Good to know

- Deleting a site deletes its Paths, versions and share link too.
<!-- requires: archive -->
- While a site is archived, nobody can roll it back from the web app: unarchive it first.
<!-- /requires -->
