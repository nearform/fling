---
title: One site, a Path per ticket
part: team-sites
order: 10
summary: Publish a folder per ticket into one team site, each with its own versions and owners.
requires: [paths]
sources: [apps/api/src/paths.ts, apps/api/src/publication.ts, packages/shared/src/publish-path.ts, packages/shared/src/limits.ts, apps/cli/src/commands/paths.ts, apps/web/src/pages/Path.tsx, apps/web/src/components/site/Path*.tsx, apps/web/src/components/site/SitePaths.tsx, packages/shared/src/mcp-tools.ts]
verified: 60d6113
---

A team site holds many pieces of work in one place: a plan per ticket, a report per week. Each
piece is a **Path**: a top-level folder of the site, such as `/PAY-412/`, published on its own. A
Path has its own versions, rollback, owners and publishers, so teammates (and their agents) can
publish different Paths at the same time without getting in each other's way.

Who can open a Path is the site's, so you set access once for the whole team. Publishing a Path
never touches the site's own pages or any other Path. A Path is served at
`{{instance:site:payments-plans}}/PAY-412/`.

## In Claude or ChatGPT

- "Publish this plan to `payments-plans` as `PAY-412`."
- "What Paths are on `payments-plans`?"
- "Roll `PAY-412` on `payments-plans` back to the previous version."

The first publish to a folder makes the Path, and you own it. If the site doesn't exist yet, it is
made too, with a home page that lists its Paths. To add owners or publishers to one Path, use the
command line or the web app.

## On the command line

Publish a folder as a Path with `--path`. It needs `--name`, the site to publish into:

```sh
fling deploy ./plan --name payments-plans --path PAY-412
```

Manage a site's Paths:

```sh
fling paths payments-plans                          # every Path: folder, title, version, state, updated
fling versions payments-plans --path PAY-412        # the Path's own versions
fling rollback payments-plans <versionId> --path PAY-412
fling owners payments-plans --path PAY-412 --add cat@example.com
fling publishers payments-plans --path PAY-412 --add bob@example.com
fling pull payments-plans ./plan --path PAY-412     # its files, to change and publish back
fling paths archive payments-plans PAY-412          # take it off the site, keep its versions
fling paths unarchive payments-plans PAY-412
fling paths delete payments-plans PAY-412           # for good (asks first unless --yes)
```

Name the folder after the ticket (`PAY-412`, `gh-1234`), not after a person.

## In the web app

Open the site from **Sites**. Its **Paths** section lists each Path with its title, address and
when it last changed, with <!-- requires: comments -->**Review** and <!-- /requires -->**View**
buttons. A long list gets a search box and a sort order.

Click a Path's folder to open its own page. There you can:

- see its **Versions**, and **Restore** an earlier one;
- change its **Owners and publishers**;
- **Archive…** it (its address returns 404, its versions are kept) or **Delete…** it for good, in
  the **Danger zone**.

## Who can do what

- The site's owners own every Path too.
- A Path's own owners and publishers can publish it and roll it back. Its owners can also change its
  owners and publishers, and archive or delete it.
- The site's publishers can make new Paths, but can't publish to a Path someone else owns.

## When it goes wrong

- **`path_not_yours`**: someone else's Path is at that folder. Ask one of its owners to make you a
  publisher of it, or publish to another folder.
- **"path must be one top-level folder"**: a Path is one folder. `reports/2026` is refused: publish
  `reports` with `2026/` inside it.
- **`base_changed`**: another publish to the same Path went live first. The command line tries once
  more on its own; otherwise publish again.
- **`paths_block_hidden`**: you published the site's own files under a folder that is a Path, and
  the Path hides them. Publish them to the Path instead, or leave them out.
- **`owner_only`**: the Path is archived, and only its owners can bring it back.

## Good to know

- A site can have up to {{fact:max-paths}} Paths, and a Path's folder name up to
  {{fact:max-folder}} characters.
- A Path's title is the title of its home page.
- The site's home page can list its Paths: see [The Paths block](/guide/team-sites/paths-block).
<!-- requires: forms -->
- [Forms](/guide/feedback/forms) belong to the whole site, not to a Path. Publish them with the
  site's own pages.
<!-- /requires -->
