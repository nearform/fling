---
paths:
  - "**/tests/**"
  - "**/*.test.ts"
  - packages/conformance/**
  - packages/e2e/**
---

# Testing

- **Assert behaviour, not registries.** Never pin the contents or order of a list that grows: the
  `MIGRATIONS` list, a run report's entries, capability sets, route lists. Look entries up by id,
  derive the expected values from the source list (for example `auto: false` → `skipped`), and
  assert the contract instead (done, idempotent, nothing runs twice). To check a test, add a
  throwaway entry (for example a no-op migration `0004`) and confirm the suites still pass, then
  remove it.
- **Adapter behaviour belongs in `packages/conformance`.** Each suite runs against every adapter:
  the core's memory and fs adapters, DynamoDB Local and MinIO (in CI, or locally with the services
  in `platforms/aws/tests/services.ts`), and Miniflare's D1, R2 and KV. Don't test one adapter's
  semantics on its own when a conformance case can cover all of them.
- **User-visible behaviour belongs in the e2e scenario** (`packages/e2e/src/scenario.ts`). It runs
  on both local runtimes (`pnpm e2e`, after `pnpm build`) and against live instances as the smoke
  test, so it must:
  - act only through the CLI, HTTP and MCP;
  - clean up everything it creates;
  - poll for changes to existing routes, using `propagationMs`;
  - skip any step whose credentials it was not given.
- The DynamoDB Local and MinIO suites only run where their env vars are set, which means CI. A
  change to the AWS adapters or the Lambda entry point can pass `pnpm gate` locally and fail in CI.
  Run them locally (see `services.ts`) before you push such a change.
- API tests use the helpers in `apps/api/tests/helpers.ts`, and `tests/idp.ts` for a fake OIDC
  provider. Never call a real provider or cloud in a unit test.
- Timeouts and the test include pattern come from `vitest.shared.ts`. CI runners are slow, so don't
  lower the timeouts per test.
