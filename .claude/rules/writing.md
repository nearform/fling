# Writing code, comments and docs

- **Describe what is, not what was.** Comments, docs and test names state the
  current behaviour and the reason for it. Leave out history: "previously", "used to", "no longer",
  "the old X", phase numbers, who asked for it. History belongs in git and in PR descriptions. The
  exceptions are migrations, whose headers explain the data they rewrite, and user-facing upgrade
  notes in `apps/cli/CHANGELOG.md`.
- Match the surrounding code: file-header comments explain the module's job and its constraints.
  Inline comments explain why, never what.
- Use the terms in `CONTEXT.md`. When you add a concept, add it there in the same style: one bold
  term, then a short definition with the file that owns it.
- Prose is British English (behaviour, colour), plain and direct.
- Formatting is Biome's (`pnpm lint:fix`): two-space indent, single quotes, no semicolons, 100
  columns, `import type` for types.
- When behaviour changes, update the docs that describe it in the same change: README, CONTEXT.md,
  `docs/development.md`, both `DEPLOY.md` guides, `apps/cli/README.md`, the plugin's `SKILL.md`.
