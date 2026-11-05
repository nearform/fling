---
title: Publish a site
part: publish
order: 10
summary: Fling a folder, a page or a zip and get its address back.
sources: [apps/cli/src/commands/deploy.ts, apps/cli/src/deploy.ts, apps/cli/src/inputs.ts, apps/cli/src/cli.ts, apps/api/src/publication.ts, packages/shared/src/mcp-tools.ts]
verified: 60d6113
---

Publishing (flinging) puts your files online at `https://<name>.{{instance:sites}}`. Fling the same
name again to update it: the address stays the same, and earlier versions are kept.

You can fling a folder (usually a build's output, such as `dist`), a single HTML page, a zip of a
site, or any other file, such as a PDF or an image, which gets a small page that shows it.

## In Claude or ChatGPT

- "Fling this page as q3-report"
- "Build the app and fling the dist folder as my-app"
- "Fling Pitch Deck.html from my Downloads"
- "Fling it again": after a change, to update the same site

Your assistant confirms the name with you, and for a new site asks who should be able to open it.

## On the command line

Point `fling deploy` at what you want to publish:

```sh
fling deploy ./dist --name my-app     # a folder
fling deploy "Pitch Deck.html"        # one page, served as the home page
fling deploy site.zip                 # a zip, unpacked first
fling deploy diagram.svg              # any other file, on a page that shows it
fling ./dist                          # the same as fling deploy ./dist
```

Without `--name`, Fling makes a name from the project and folder (or the file's name) and asks you
to confirm it:

```
Site name: my-app → {{instance:site:my-app}}  (new)
Use "my-app"? [Y/n or type another name]
```

Press Enter to accept, type another name to check that one instead, or `n` to stop. The note says
`(new)` for a new site or `(updates your existing site)`.

**A single-page app** (React Router, Vue Router and the like) needs `--spa`, so a link deep into
the app opens it instead of a 404:

```sh
fling deploy ./dist --name my-app --spa
```

**Who can open a new site** is set with `--access`: `only_me`, `members` (everyone signed in),
`people` with `--add`, `groups` with `--group`, or `public`. Without it, the site gets your Fling's
default and the result says who that is. See [Who can open a site](/guide/share/who-can-open).

**In scripts and CI**, add `--yes`: Fling never asks, uses the generated name, and fails if that
name is taken. Pass `--name` to be sure of the name.

## What you get back

The address of the site, `{{instance:site:my-app}}`, and who can open it.

<!-- requires: comments -->
With it comes a review link, `{{instance:origin}}/review/my-app`. That is the
one to share when you want feedback: reviewers sign in and see the site beside its comments. See
[Comments](/guide/feedback/comments).
<!-- /requires -->

Fling the same files again and nothing happens: the result says `Unchanged`. Fling files you
published before and that version is put back at once, without uploading anything.

## When it goes wrong

- **"No index.html at the root".** The folder has no home page. If it has other HTML pages, Fling
  offers to make a home page that lists them (press `L`), or you can fling it anyway and its
  address shows a 404 (`f`). Often you flung the project instead of its build output: try
  `./dist`. `--list-html` and `--no-list-html` decide up front.
- **"is taken by someone else".** Someone else has that name. Pick one of the suggestions:
  see [Site names](/guide/publish/names).
- **"Refusing to publish" or "found secrets".** Fling never publishes keys, credentials or files
  containing them. See [What gets published](/guide/publish/what-gets-published).
- **Too large.** One publish holds up to {{fact:max-deploy}} and {{fact:max-files}} files, none
  over {{fact:max-file}}.
- **`owner_only`.** You publish this site but don't own it, so you can't change its settings
  (`--access`, `--public`, `--spa`) or bring it back from the archive. Ask an owner.

## Good to know

- Absolute links such as `/assets/app.js` work: each site has its own address.
- `--spa` stays on for later publishes once set.
- When an owner publishes an archived site, it comes back online.
