/**
 * The post-deploy smoke test: the same scenario as `pnpm e2e`, against a deployed instance, signed
 * in with an API key (no browser). It creates three sites named `e2e-<random>…` and removes them.
 *
 *   FLING_E2E_API_KEY=fling_… tsx src/smoke.ts https://fling.example.com [--propagation-seconds 120]
 *
 * The key belongs to a test user of the instance (create it in the web UI, API keys page) and is a
 * secret of the deploy workflow. Without a browser session there is no `fling_site` cookie, so the
 * private-site check is the sign-in redirect only. FLING_E2E_MEMBER_API_KEY, a key of a second test
 * user, adds what a member may do on the first one's site (comments); without it that is skipped.
 * FLING_E2E_ADMIN_API_KEY, a key of a user in ADMIN_EMAILS, adds the users list (and checks that
 * a key cannot impersonate); impersonation itself needs a browser session, so only `pnpm e2e`
 * runs it. Without the key the admin checks are skipped. With the member and admin keys, the
 * audience and group checks run through the API (the admin as the outsider, and as the one the
 * member's group lets in); the site pass needs browser sessions, so only `pnpm e2e` follows it.
 * On an instance with email, it checks that the notification settings answer and sends nothing:
 * there is no dev drain, so what each person is sent is only checked by `pnpm e2e`.
 */
import { parseArgs } from 'node:util'
import { runScenario } from './scenario.ts'
import { apiKeySession } from './sign-in.ts'

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'propagation-seconds': { type: 'string', default: '120' } },
})

const appOrigin = positionals[0] ?? process.env.FLING_URL
const apiKey = process.env.FLING_E2E_API_KEY
if (!appOrigin || !apiKey) {
  console.error('usage: FLING_E2E_API_KEY=… tsx src/smoke.ts <app origin>')
  process.exit(2)
}

console.log(`Smoke test: ${appOrigin}`)
try {
  const session = await apiKeySession(appOrigin, apiKey)
  const memberKey = process.env.FLING_E2E_MEMBER_API_KEY
  const member = memberKey ? await apiKeySession(appOrigin, memberKey) : undefined
  const adminKey = process.env.FLING_E2E_ADMIN_API_KEY
  const admin = adminKey ? await apiKeySession(appOrigin, adminKey) : undefined
  const t0 = Date.now()
  await runScenario({
    appOrigin,
    session,
    member,
    admin,
    propagationMs: Number(args['propagation-seconds']) * 1000,
  })
  console.log(`  passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
} catch (err) {
  console.error(`  ✗ ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
