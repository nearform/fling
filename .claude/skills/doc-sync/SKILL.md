---
name: doc-sync
description: Bring Fling's user guide (/guide, apps/web/content/guide) back in line with the code it describes. Use after changing code a Guide page names in its sources (the Stop hook says "run /doc-sync before committing"), when `node scripts/docs-stale.mjs` lists stale pages, or when asked to sync, check or audit the guide. `/doc-sync` fixes the stale pages; `/doc-sync audit` checks every page and proposes edits without applying them.
---

# doc-sync

Every Guide page (`apps/web/content/guide/<part>/<page>.md`; not `VOICE.md`, not `_*/`) names the
code it describes and the commit it was last checked at:

```yaml
sources: [apps/cli/src/commands/**, apps/api/src/publication.ts]
verified: 2a22b5f
```

`node scripts/docs-stale.mjs` lists every page whose sources changed after `verified` (a commit
that also edits the page counts as a check). The register and page shape are
`apps/web/content/guide/VOICE.md`; the rules are `.claude/rules/guide.md`.

## The rules

- **The code is the truth.** Read the code, not a comment, a README or another page about it.
- **Change only the claims the diff touched.** Never polish prose it didn't.
- **Facts, not literals**: a limit or a name the code owns is `{{fact:key}}`
  (`packages/shared/src/guide-facts.ts`); an instance's address or name is `{{instance:key}}`.
- **Describe what Fling does today.** No "new", "soon" or "previously".
- **Invented examples only**: `my-app`, `PAY-412`, `ana@example.com`.

## `/doc-sync` (the stale pages)

1. **Gather.** `node scripts/docs-stale.mjs --json` → `{ stale: [{ doc, verified, files }], errors }`.
   Fix `errors` first: bad frontmatter, a glob that matches nothing (point it where the code went),
   an unknown sha. Add pages describing what the working tree changed:
   `node scripts/docs-stale.mjs --changed`.
2. **Read the diff, then the page.** `git diff <verified>..HEAD -- <files>` and the working tree.
   List every claim in the page the diff could touch: behaviour, commands and flags, button and
   page names, limits, who may do what, the order of steps, which capability gates it.
3. **Check each claim against the code as it is now.** Leave a right claim alone.
4. **Rewrite the wrong ones** in the page's register. A new capability gate: `requires`. A new
   limit: a fact. A feature the page doesn't cover yet: a section, or a new page with its own
   `sources` and `verified`.
5. **Fact-check with a separate sub-agent**: give it the edited pages, the diff and the code to
   read; ask it to verify every changed sentence against the code. Fix what it finds.
6. **Move `verified`** on every page you checked to the newest commit of `main` it was checked
   against (`git rev-parse --short origin/main` after rebasing onto it), never a commit of your
   branch: merging rebases the branch, so its commits never reach `main`. Your commit that edits
   the page counts as the check for anything after.
7. **Repeat** `node scripts/docs-stale.mjs` until it is clean, then `pnpm gate` (its guide tests
   check frontmatter, facts, placeholders, links and anchors). Look at changed pages in the
   browser: `pnpm dev`, `pnpm --filter @fling/web dev`, `http://fling.lvh.me:47100/guide`.

Report the pages checked and each claim changed (page, old, new, the code that proves it).

## `/doc-sync audit` (every page)

A report and proposed edits, never silent rewrites; apply them once the user agrees.

1. **Drift**: check every page against the code whatever its `verified`: one sub-agent per part,
   and a separate one spot-checking their findings. Look for behaviour that changed outside a
   page's `sources` (propose wider globs).
2. **Coverage**: features with a capability, a CLI command or an MCP tool that no page describes.
3. **Repetition**: the same fact in two pages; name the owner, propose a link or a fact.
4. **Report** by page.
