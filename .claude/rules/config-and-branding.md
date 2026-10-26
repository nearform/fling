---
paths:
  - apps/api/src/config.ts
  - apps/api/src/instance.ts
  - packages/shared/src/instance.ts
  - packages/shared/src/distribution.ts
  - platforms/aws/infra/**
  - platforms/aws/scripts/**
  - platforms/cloudflare/scripts/**
  - platforms/cloudflare/wrangler.jsonc
  - platforms/*/DEPLOY.md
  - apps/web/**
  - scripts/check-names.mjs
---

# Instance configuration and branding

- Instance values are configuration, never literals: name, domains, who may sign in, admins,
  OIDC, brand colours, logos, feature switches. The core validates them in one zod schema
  (`apps/api/src/config.ts`) and refuses to start on bad values in production.
- `pnpm lint` runs `scripts/check-names.mjs`. The publisher's name may appear only as the CLI's npm
  package and the GitHub repo, both defined in `packages/shared/src/distribution.ts`. Code imports
  those constants. Add a file to the script's allowlist only when it cannot import them (a
  manifest, a doc, a workflow).
- **Adding a config value** touches, in one change:
  1. `config.ts` (schema, defaults and production checks) and its use;
  2. if clients need it, `instance.ts` and `InstanceMetadataSchema` in `packages/shared`. Public
     metadata never includes email addresses or secrets;
  3. the Instance configuration table in `platforms/aws/DEPLOY.md` (the Cloudflare guide links to
     it), plus any platform-specific notes in either guide;
  4. how each platform receives it: the `INSTANCE` object of `AWS_DEPLOY_CONFIG` (shipped as
     `instance.json`) and of the Cloudflare deploy config (`scripts/setup.mjs`, `scripts/config.mjs`);
     a secret goes in SSM on AWS and in Worker secrets on Cloudflare.
- A feature an instance can switch off becomes a capability flag (`capabilities` in the metadata).
  Clients hide the feature when the flag is missing.
- The web UI is themed at runtime from the metadata (`BRAND_*`). The default look is Fling's own:
  the rainbow F in `apps/web/src/components/LogoMark.tsx`, which matches `apps/web/public/logo.svg`,
  `favicon.svg`, the favicon inlined in `404.html` and `apps/cli/mcpb/icon.png`.
