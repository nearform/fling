---
title: What gets published
part: publish
order: 30
summary: The files Fling leaves out, the secrets it refuses, the home page it can make, and the limits.
sources: [apps/cli/src/manifest.ts, apps/cli/src/gitignore.ts, apps/cli/src/inputs.ts, packages/shared/src/secrets.ts, packages/shared/src/limits.ts, apps/api/src/publication.ts]
verified: 60d6113
---

Fling publishes the files a browser needs and nothing else. It leaves out what is private to your
project, refuses anything that looks like a secret, and tells you what it skipped. There is no
option to turn this off, and {{instance:name}} checks again when the files arrive.

## What is left out

From a folder (or a zip), Fling skips:

- **Dotfiles and dot-folders**: `.env`, `.npmrc`, `.git/` and the like. The result lists them.
- **Gitignored files.** When the folder you fling is itself gitignored, as `dist/` usually is, only
  the `.gitignore` files inside it count.
- **`node_modules`.**
- **Anything in a `.flingignore`** at the top of the folder, written like a `.gitignore`:

  ```
  drafts/
  *.psd
  ```

- **Links that point outside the folder.** Links within it are followed.

## Secrets stop the publish

Fling refuses to publish:

- **Files that are secrets by name**: private keys and certificates (`*.pem`, `*.key`, `id_rsa`…),
  keystores, `credentials.json`, `secrets.json`, Terraform state and variables.
- **Files that contain a secret**: private keys, cloud and API keys and tokens (AWS, GitHub, npm,
  Slack, Stripe, OpenAI, Anthropic and others), and database addresses with a password in them.

Nothing is published. Fling names the file, the line and the kind of secret, never the secret
itself. Remove it, and if it was ever shared, change it where it came from (rotate it). Or leave
the file out with `.flingignore`.

> **Warning** Never rename, re-encode or split a file to get it past the check. A secret on a
> website is public the moment someone opens the page.

## No home page

A site's address opens its `index.html`. When the folder has no `index.html` at the top but has
other HTML pages, Fling can make one for you: a page that links every HTML page, titled from each
page's own title. It is added to the site only; your folder is not changed.

<!-- requires: markdown -->
A Markdown file can be the home page too: see [Markdown pages](/guide/publish/markdown).
<!-- /requires -->

- **In your assistant**, it asks whether you want the listing or not.
- **On the command line**, Fling asks: `[L]ist the HTML pages`, `[f]ling anyway` (the address shows
  a 404) or `[a]bort`. `--list-html` and `--no-list-html` decide up front; with `--yes` it makes
  the listing.

## When it goes wrong

- **"Refusing to publish dotfiles".** Your assistant sent a file whose name starts with a dot.
  Leave it out.
- **"Refusing to publish secret files" or "found secrets".** See [Secrets stop the
  publish](#secrets-stop-the-publish).
- **A file you expected is missing.** It is gitignored, in `.flingignore`, in `node_modules`, or a
  dotfile. The result lists the dotfiles and gitignored files it skipped.
- **"Nothing to deploy".** Everything in the folder was skipped. Check you flung the right folder.

## Good to know

- One publish holds up to {{fact:max-deploy}} and {{fact:max-files}} files, none over
  {{fact:max-file}}.
- Fling hosts files only: no server code runs, so keep anything private out of the files.
