---
title: Change a published site
part: publish
order: 50
summary: Start from what is live, change some files, and publish only what changed.
requires: [pull]
sources: [apps/cli/src/commands/pull.ts, apps/cli/src/pull.ts, apps/cli/src/commands/deploy.ts, apps/api/src/pull.ts, apps/api/src/publication.ts, apps/api/src/mcp/read-files.ts, apps/web/src/components/site/SiteOverview.tsx]
verified: 60d6113
---

To fix a typo, update a page or act on review comments, start from the files that are live, not
from an old copy. Fling hands you the site's current files; you change what you need and publish
again, and only the changes are sent. If someone else published in the meantime, Fling stops rather
than overwrite their work.

Anyone signed in who can open a site can download its files. Only its owners and publishers can
publish it.

## In Claude or ChatGPT

- "Fix the typo in the heading of q3-report"
- "Apply the open comments on my-app and publish it again"
- "Update the prices table on launch-site"

Your assistant reads the site's files, changes the ones that need it, and publishes just those;
every other file stays as it is. On your computer (Claude Desktop or Claude Code) it downloads the
site into a folder first, by default `Documents/Claude/fling/<name>`.

## On the command line

Pull the site into a folder, change it, and deploy that folder:

```sh
fling pull my-app              # into ./my-app
# edit the files in ./my-app
fling deploy ./my-app          # publishes only what changed: 3 changed, 1 removed
```

The folder remembers which site, which Fling and which version it came from, so `fling deploy`
needs no name. A folder that isn't empty needs `--force` to pull into.

To change one [Path](/guide/team-sites/paths) of a team site, pull just that Path. Deploying the
folder publishes it back to the Path, and the rest of the site is untouched:

```sh
fling pull payments-plans ./pay-412 --path PAY-412
fling deploy ./pay-412
```

Owners and publishers can pull an earlier version with `--version-id <id>` (ids from `fling
versions my-app`).

## In the web app

The site's page shows the command to pull it, under **Edit locally**.

## When it goes wrong

- **`base_changed`: the site has changed since you pulled it.** Someone published it after you
  pulled. Pull again into another folder, redo your change there and deploy that. Only if you mean
  to replace what they published, deploy with `--force`.
- **"Not signed in to …, where the folder was pulled from".** The folder belongs to another Fling.
  Run the `fling login` it suggests.
- **"can't pull sites yet".** Your Fling doesn't offer this. Publish the whole site instead.
- **Forbidden when you deploy.** You can open the site but don't publish it. Ask one of its owners
  to add you as a publisher: see [Owners and publishers](/guide/share/owners-and-publishers).

## Good to know

- Deploying the pulled folder under another `--name` publishes it to that site as a whole folder,
  not as a change to the one you pulled.
- `fling deploy ./my-app --force` publishes the folder as the whole site, whatever is live.
