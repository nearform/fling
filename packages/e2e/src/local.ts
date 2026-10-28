/**
 * `pnpm e2e`: the scenario on each platform's local runtime, signed in with dev login.
 *
 *   aws         apps/api/src/dev.ts: the core on Node with the memory table, fs blobs and the
 *               real CloudFront Function (the generated bundle) in front of the sites; mail
 *               through MemoryMailer (MAIL_DRIVER=memory)
 *   cloudflare  platforms/cloudflare under `wrangler dev`: the Worker with local D1, R2 and KV
 *               (scripts/dev.mjs applies the D1 schema and the data migrations first); mail
 *               through the real CloudflareMailer over wrangler's simulated `send_email` binding
 *
 *   tsx src/local.ts [aws] [cloudflare]      (default: both, one after the other)
 *
 * Each runtime gets free ports and a fresh temporary state, and is stopped afterwards (pass or
 * fail). Needs the web build (pnpm build) for the Worker's assets.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO } from './cli.ts'
import { runScenario } from './scenario.ts'
import { devLogin } from './sign-in.ts'

interface Runtime {
  name: string
  appOrigin: string
  start(state: string): ChildProcess
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

const secret = () => randomBytes(32).toString('base64url')
const tsx = join(REPO, 'node_modules', '.bin', 'tsx')

async function awsRuntime(): Promise<Runtime> {
  const [api, sites] = [await freePort(), await freePort()]
  const appOrigin = `http://fling.lvh.me:${api}`
  return {
    name: 'aws (apps/api dev server + the CloudFront Function)',
    appOrigin,
    start: state =>
      spawn(tsx, [join(REPO, 'apps', 'api', 'src', 'dev.ts')], {
        cwd: REPO,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PORT: String(api),
          SITES_PORT: String(sites),
          APP_ORIGIN: appOrigin,
          SITES_DOMAIN: `fling.lvh.me:${sites}`,
          SITE_COOKIE_DOMAIN: 'fling.lvh.me',
          FS_ROOT: state,
          SESSION_SECRET: secret(),
          SITE_HMAC_KEY: secret(),
          MAIL_DRIVER: 'memory',
          MAIL_FROM: 'fling@mail.fling.lvh.me',
        },
      }),
  }
}

async function cloudflareRuntime(): Promise<Runtime> {
  const [port, inspector] = [await freePort(), await freePort()]
  return {
    name: 'cloudflare (wrangler dev: the Worker on local D1, R2, KV)',
    appOrigin: `http://flingcf.lvh.me:${port}`,
    start: state =>
      spawn(
        process.execPath,
        [
          join(REPO, 'platforms', 'cloudflare', 'scripts', 'dev.mjs'),
          '--port',
          String(port),
          '--inspector-port',
          String(inspector),
          '--persist-to',
          state,
          '--mail',
        ],
        {
          cwd: REPO,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, SESSION_SECRET: secret(), SITE_HMAC_KEY: secret() },
        }
      ),
  }
}

async function waitForHealth(origin: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`the runtime exited (${child.exitCode}):\n${output()}`)
    try {
      const res = await fetch(`${origin}/healthz`)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`${origin}/healthz never answered:\n${output()}`)
}

/** Stop the runtime and everything it started (wrangler runs workerd as a child). */
function stop(child: ChildProcess) {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

async function run(runtime: Runtime): Promise<boolean> {
  console.log(`\n${runtime.name}: ${runtime.appOrigin}`)
  const state = mkdtempSync(join(tmpdir(), 'fling-e2e-state-'))
  const child = runtime.start(state)
  let output = ''
  child.stdout?.on('data', d => {
    output += d
  })
  child.stderr?.on('data', d => {
    output += d
  })
  const started = Date.now()
  const onExit = () => stop(child)
  process.on('exit', onExit)
  try {
    await waitForHealth(runtime.appOrigin, child, () => output.slice(-4000))
    console.log(`  started in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    const session = await devLogin(runtime.appOrigin, 'e2e@example.test')
    const member = await devLogin(runtime.appOrigin, 'e2e-member@example.test')
    // With dev login on and no ADMIN_EMAILS, this is the instance's admin (DEV_ADMIN_EMAILS).
    const admin = await devLogin(runtime.appOrigin, 'admin@example.test')
    const outsider = await devLogin(runtime.appOrigin, 'e2e-outsider@example.test')
    const t0 = Date.now()
    await runScenario({ appOrigin: runtime.appOrigin, session, member, admin, outsider })
    console.log(`  passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    return true
  } catch (err) {
    console.error(`  ✗ ${err instanceof Error ? err.message : err}`)
    if (process.env.FLING_E2E_VERBOSE) console.error(output.slice(-8000))
    return false
  } finally {
    stop(child)
    process.off('exit', onExit)
    await new Promise(r => setTimeout(r, 500))
    rmSync(state, { recursive: true, force: true })
  }
}

const RUNTIMES: Record<string, () => Promise<Runtime>> = {
  aws: awsRuntime,
  cloudflare: cloudflareRuntime,
}

const wanted = process.argv.slice(2).filter(a => !a.startsWith('-'))
const names = wanted.length ? wanted : Object.keys(RUNTIMES)
for (const name of names) {
  if (!RUNTIMES[name]) {
    console.error(`unknown runtime ${name} (${Object.keys(RUNTIMES).join(', ')})`)
    process.exit(2)
  }
}
// Ctrl-C: exit, so the 'exit' handlers stop whatever is running.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(130))
let failed = 0
for (const name of names) {
  const make = RUNTIMES[name] as () => Promise<Runtime>
  if (!(await run(await make()))) failed++
}
process.exit(failed ? 1 : 0)
