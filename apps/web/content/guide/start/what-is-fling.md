---
title: What Fling is
part: start
order: 10
summary: Publish a folder of static files and get a link back, from your assistant, the command line or the web.
sources: [README.md, packages/shared/src/distribution.ts]
verified: 60d6113
---

{{instance:name}} puts a folder of static files online and gives you a link back:
`{{instance:site:my-app}}`. A page Claude made you, a report, a prototype, a build of an app: if
it runs in a browser without a server of its own, it can be flung.

Every site is private until you say otherwise: only you, the people you choose, or
{{instance:audience}} can open it. You choose who sees it, keep earlier versions, and collect comments from the people you share it with.

## Three ways in

You can use Fling from wherever you work. They all reach the same sites.

| From | Good for | Set it up |
|---|---|---|
| Claude or ChatGPT | "Fling this page", without leaving the chat | [Connect your assistant](/guide/start/connect) |
| The command line | Build folders, scripts and coding agents | [The CLI](/guide/start/cli) |
| The web app | Seeing your sites, sharing, versions, comments | [{{instance:origin}}]({{instance:origin}}) |

## What a site is

A site is a name and the files you published under it. The name becomes its address,
`https://<name>.{{instance:sites}}`, and stays yours until you delete the site. Publish again and
the same address shows the new files; the earlier version is kept, so you can put it back.

> **Note** Fling hosts static files only: HTML, CSS, JavaScript, images, documents. There is no
> server-side code, and no database of your own.

## Good to know

- One publish can hold up to {{fact:max-deploy}}, with no file over {{fact:max-file}}.
- Fling never publishes dotfiles, keys, credentials or files containing secrets. When it finds a
  secret, it stops and tells you which file and line.
