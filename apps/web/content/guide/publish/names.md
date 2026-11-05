---
title: Site names
part: publish
order: 20
summary: How names work, who gets one, and what to do when yours is taken.
sources: [packages/shared/src/site-labels.ts, packages/shared/src/hosts.ts, apps/cli/src/naming.ts, apps/api/src/sites.ts, apps/cli/src/commands/deploy.ts]
verified: 60d6113
---

A site's name is its address: `my-app` is served at `{{instance:site:my-app}}`. Names are shared by
everyone on {{instance:name}} and are first come, first served: the first person to publish a name
has it until they delete the site.

## The rules

- Lowercase letters, digits and single hyphens: `q3-report`, `launch-2026`.
- Up to {{fact:site-name-max}} characters, starting and ending with a letter or digit.
- A few names are reserved, such as `api`, `www` and `fling`.

## In Claude or ChatGPT

- "Is the name q3-report free?"
- "What name would my dist folder get?"

Your assistant checks a name before it publishes a new site and confirms it with you. When the
name is someone else's, it offers free ones instead and lets you choose; it never picks another
name on its own.

## On the command line

Give the name with `--name`, or let Fling make one and confirm it when asked:

```sh
fling deploy ./dist --name my-app
```

Without `--name`, the name comes from your project, never from your own name. Fling finds the
project's top folder (the one with `.git`, or else `package.json` and the like) and joins its name
with the folders below it, skipping build output such as `dist` and `build` and containers such as
`apps` and `src`:

| Folder | Name |
|---|---|
| `~/work/rocketpod/docs` | `rocketpod-docs` |
| `~/work/myapp/dist` | `myapp` |
| `~/work/mono/apps/web/dist` | `mono-web` |

A single file is named after itself: `Pitch Deck (1).html` becomes `pitch-deck`.

## When it goes wrong

- **The name is taken.** Fling suggests free names made from yours and your initials, such as
  `my-app-ab` and `my-app-ab2`. Accept one at the prompt, type another, or deploy again with
  `--name`. With `--yes`, or from a script, a taken name stops the deploy with the suggestions.
- **"is not a valid site name".** It breaks a rule above: capitals, spaces, a double hyphen, too
  long, or reserved.
- **Fling says the name "updates your existing site".** It is already yours: publishing replaces
  what is there, and the earlier version is kept.

## Good to know

- Archiving a site keeps its name; deleting it frees the name for anyone. See [Archive or
  delete](/guide/publish/archive-and-delete).
- A share link has its own address and never uses the name. See [Share
  links](/guide/share/share-links).
