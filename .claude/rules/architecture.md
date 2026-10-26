# Architecture rules

Fling runs on several clouds and is not tied to any one instance. Every change keeps it that way.

- **The core is cloud-agnostic.** `apps/api` and `packages/shared` never import a cloud SDK; Biome
  enforces this with `noRestrictedImports`. Cloud code lives in `platforms/<cloud>/`, behind the
  core's ports: `Table`, `Blobs`, `RouteTable` and `IdentityProvider`. A feature that needs
  something new from storage extends a port and every adapter, and each adapter must pass the
  conformance suite for that port.
- **Write once.** Domain logic, persistence (Records over Table), migrations, policy and the sites'
  routing decision exist once, in the core or in `packages/shared`. A platform only adapts. If you
  find yourself writing the same logic in two platforms, move it into the core.
- **Capabilities, never platform checks.** When instances differ, the core advertises a flag in
  `/.well-known/fling` (`capabilities`, built in `apps/api/src/instance.ts`). Clients (web, CLI,
  MCP) read that flag. Nothing checks which cloud it is running on.
- **The edge only rewrites.** The CloudFront Function and the Worker's sites host map
  `routeSiteRequest` (`packages/shared/src/site-routing.ts`) onto their runtime. They do lookups
  and rewrites, never generate content or apply policy of their own.
- **Authorization goes through `policy.ts`.** `can(actor, action, site)` decides for sites and
  `canInstance` for admin actions. No route, MCP tool or key layout decides access by itself.
- **Instance-agnostic artifacts.** The CLI, plugin, MCP servers and web UI learn everything about an
  instance from `/.well-known/fling`. No instance's domain, email, logo or colour appears in the
  code; those are configuration.
- **Every platform passes everything.** A feature is done when the adapter conformance suites pass
  on every adapter and the e2e scenario (`packages/e2e/src/scenario.ts`) covers it and passes on
  both local runtimes (`pnpm e2e`).
