/**
 * Settings every package's vitest config shares. The timeouts are generous on purpose: a shared CI
 * runner can be several times slower than a laptop (Miniflare's D1, DynamoDB Local, spawned
 * processes), and a test that hangs still fails, a minute later.
 */
export const sharedTest = {
  environment: 'node' as const,
  include: ['tests/**/*.test.ts'],
  testTimeout: 60_000,
  hookTimeout: 120_000,
}
