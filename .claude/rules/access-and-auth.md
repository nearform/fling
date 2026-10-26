---
paths:
  - apps/api/src/policy.ts
  - apps/api/src/sites.ts
  - apps/api/src/comments.ts
  - apps/api/src/admin.ts
  - apps/api/src/publication.ts
  - apps/api/src/routes/**
  - apps/api/src/mcp/**
  - apps/api/src/auth/**
  - apps/api/src/oauth/**
---

# Access, sign-in and publication

- **Every site access goes through policy.** A route or MCP tool that touches a site resolves it
  with `requireSite` (`sites.ts`), which calls `can(actor, action, site)`. A new action gets a row in
  `policy.ts` and test cases in `tests/policy.test.ts`. The policy test also runs the real site
  router against the policy table, so `site.view` cannot drift from what the edge enforces.
- A refusal looks like a missing site (404), so a refusal never reveals that a site exists.
- Admin-only behaviour goes through `canInstance` and `ADMIN_EMAILS`, checked on every request.
  While an admin impersonates a user, nothing may outlive the session: no API keys, no
  `fling login`, no OAuth approvals, no nested impersonation. Audit every start and stop.
- Sign-in is generic OIDC (`auth/oidc.ts`, behind `IdentityProvider`). Never add code specific to
  one provider. Who may sign in is decided only by the email policy (`auth/identity.ts`:
  `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS`), and it requires a verified email.
- Publication (`publication.ts`) is the only way a version goes live. Every path to it goes through
  admission, staging and the secret scan. Nothing may skip the scan. The CLI's own checks exist only
  to give earlier messages.
- The API, the remote MCP server and the CLI and local MCP expose the same features. A new
  capability usually needs an API route, an MCP tool, a CLI command and a web view, all gated on
  the same capability flag.
