---
title: Versions and rollback
part: publish
order: 60
summary: Every publish is kept as a version; put an earlier one back in an instant.
requires: [rollback]
sources: [apps/api/src/sites.ts, apps/api/src/publication.ts, apps/cli/src/commands/sites.ts, apps/web/src/components/site/SiteVersions.tsx, apps/web/src/components/site/PathVersions.tsx]
verified: 60d6113
---

Each time you publish new files, Fling keeps them as a version and serves the newest. The earlier
versions stay. Rolling back makes one of them live again, at the same address, straight away:
nothing is uploaded.

A site's owners and publishers can roll it back.

## In your assistant

- "Show me the versions of my-app"
- "Roll my-app back to the version from yesterday morning"
- "Put the previous version of q3-report back"

## On the command line

List the versions, newest first. A `*` marks the one being served:

```sh
fling versions my-app
```

Then roll back to one, by its id from that list:

```sh
fling rollback my-app <versionId>
```

For a [Path](/guide/team-sites/paths) of a team site, add `--path` to see and roll back only that
Path; the rest of the site stays as it is:

```sh
fling versions payments-plans --path PAY-412
fling rollback payments-plans <versionId> --path PAY-412
```

`fling files my-app <versionId>` lists the files in any version.

## In the web app

Open the site from **Sites**. Its **Versions** section shows the files being served, then the
**History**: each version with when it was flung, who published it, its files and size. Click
**Files** to see a version's files, and **Restore** to serve it. The one being served is marked
**Current**.

A Path's own page has the same **Versions** section for that Path.

## When it goes wrong

- **Restore is greyed out.** The site is archived. Unarchive it first: see [Archive or
  delete](/guide/publish/archive-and-delete).
- **You rolled back, but the address still shows a 404.** The site is archived. On the command line
  the rollback picks the version it will serve once an owner unarchives it.
- **Publishing the same files again made no new version.** A version is its files: publishing a
  set of files you published before puts that version back rather than adding a copy.

## Good to know

- Rolling back changes only the files. Who can open the site, and its share link, stay as they are.
- Delete the site and its versions go with it. Archiving keeps them.
- Whoever runs {{instance:name}} can limit how many versions each site keeps; older ones beyond
  that are deleted. The one being served is always kept.
