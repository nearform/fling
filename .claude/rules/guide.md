---
paths:
  - apps/web/content/guide/**
  - apps/web/src/guide/**
  - apps/web/src/pages/guide/**
  - packages/shared/src/guide.ts
  - packages/shared/src/guide-facts.ts
  - scripts/docs-stale.mjs
  - scripts/lib/docs-stale.mjs
---

# The Guide

The user guide every instance serves at `/guide`: Markdown pages in
`apps/web/content/guide/<part>/<page>.md`, bundled into the web app, shown with the instance's own
address and features. `VOICE.md` there is the register and the page shape; read it before writing.

- **The code is the truth.** When a page and the code disagree, the code wins. Check a claim
  against the code, not a comment, a README or another page.
- **Nothing instance-specific in a page.** An address, a name, the install command, who may sign in:
  `{{instance:…}}` placeholders, filled in from `/.well-known/fling`. A number or name the code
  owns: `{{fact:…}}` from `packages/shared/src/guide-facts.ts`, which imports the constant (a
  constant shared cannot import is pinned there and checked by `apps/web/tests/guide.test.ts`).
- **Features an instance can lack are gated**: `requires: [capability]` on the page, or
  `<!-- requires: x -->…<!-- /requires -->` around a passage. Admin pages carry `audience: admin`.
- **Every page says what it describes and when it was checked**: `sources` (coarse globs) and
  `verified` (a commit). When you change code a page's `sources` match, the Stop hook names the
  page; run `/doc-sync` before committing. A commit that edits the page counts as its check.
- **Never a line number, never a file of Fling's code in a page.** Name what the reader sees: a
  command, a flag, a button, a page of the web app.
- A new part goes in `GUIDE_PARTS` (`packages/shared/src/guide.ts`); a new page needs nothing else.
  Link pages by address (`/guide/<part>/<page>#section`); the tests check every link and anchor.
