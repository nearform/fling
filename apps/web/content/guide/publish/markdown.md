---
title: Markdown pages
part: publish
order: 40
summary: Publish Markdown as it is; Fling serves it as a formatted page.
requires: [markdown]
sources: [packages/shared/src/markdown.ts, packages/shared/src/markdown-path.ts, apps/api/src/rendering.ts, packages/shared/src/site-routing.ts]
verified: 60d6113
---

Publish a plan, a spec or notes written in Markdown without turning them into HTML first. Each
`.md` or `.markdown` file is served as a formatted page, in GitHub's flavour of Markdown: tables,
task lists, code blocks and the rest.

## How pages are served

- `docs/plan.md` opens at `{{instance:site:my-app}}/docs/plan.md`, formatted.
- Add `?raw=1` to the address for the Markdown itself: `…/docs/plan.md?raw=1`.
- **A folder without an `index.html`** gets a home page from its Markdown: its `index.md`, else its
  `README.md`, else its only Markdown file. A folder of notes with a `README.md` opens on it.
- Links between Markdown files work as you wrote them: `[the spec](spec.md)` opens the formatted
  spec.

## In Claude or ChatGPT

- "Write up the plan as Markdown and fling it as payments-plan"
- "Fling my notes folder as team-notes"

## On the command line

Fling a Markdown file on its own, or a folder that holds some:

```sh
fling deploy plan.md --name payments-plan    # the file is the site's home page
fling deploy ./notes --name team-notes
```

## When it goes wrong

- **A page shows as plain text.** It is not named `.md` or `.markdown`, or it is too big to format:
  Fling formats files up to {{fact:markdown-max-size}}, and up to {{fact:markdown-max-files}} of
  them in one publish. The rest are served as they are.
- **The site's address shows a 404.** There is an `index.md` or `README.md` only inside a folder,
  not at the top. Add one at the top, or link to the folder.

## Good to know

- HTML inside your Markdown is kept, as it is your site.
- A page you pull or read back is the Markdown you published, not the formatted page.
