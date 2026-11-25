/**
 * `pnpm e2e`: the scenario on each platform's local runtime, signed in with dev login.
 *
 *   aws         apps/api/src/dev.ts: the core on Node with the memory table, fs blobs and the
 *               real CloudFront Function (the generated bundle) in front of the sites; mail
 *               through MemoryMailer (MAIL_DRIVER=memory); outside invitations on (INVITES=on);
 *               site servers on for members (dev.ts's default) as Node child processes
 *   cloudflare  platforms/cloudflare under `wrangler dev`: the Worker with local D1, R2 and KV
 *               (scripts/dev.mjs applies the D1 schema and the data migrations first); mail
 *               through the real CloudflareMailer over wrangler's simulated `send_email` binding,
 *               kept for `/dev/mail` (KeptMailer); outside invitations on (`--invites`); site
 *               servers on for members (`--servers members`) in the local Worker Loader
 *   node        platforms/node's host (src/main.ts): one server for the app and the sites, the
 *               Postgres Table on PGlite, fs blobs, the core's sites host; mail through
 *               MemoryMailer; outside invitations on; site servers on for members as Node child
 *               processes
 *
 *
 *   Each runs the archive policy (ARCHIVE_POLICY below), in dry run until the scenario turns it
 *   live, and runs the dev clock the scenario moves on (`POST /dev/clock`).
 *
 *   attached    an instance already running with dev login on, at FLING_E2E_ORIGIN (the self-host
 *               compose file under its local override: platforms/node/deploy/compose/smoke.sh);
 *               nothing is started or stopped, and it is never among the defaults
 *
 *   tsx src/local.ts [aws] [cloudflare] [node] [attached]   (default: all but attached, in turn)
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
  /** absent: the runtime is already running (attached) */
  start?(state: string): ChildProcess
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

/**
 * The archive policy on every runtime, in days (views are counted by default, which it needs). It
 * acts only once the dev clock is moved on, which the scenario does last of all.
 */
const ARCHIVE_POLICY = {
  ARCHIVE_INACTIVE_DAYS: '30',
  ARCHIVE_WARN_DAYS: '7',
  DELETE_ARCHIVED_DAYS: '30',
  PURGE_DELETED_DAYS: '30',
}
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
          INVITES: 'on',
          ...ARCHIVE_POLICY,
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
          '--invites',
          '--servers',
          'members',
        ],
        {
          cwd: REPO,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            SESSION_SECRET: secret(),
            SITE_HMAC_KEY: secret(),
            ...ARCHIVE_POLICY,
          },
        }
      ),
  }
}

async function attachedRuntime(): Promise<Runtime> {
  const appOrigin = process.env.FLING_E2E_ORIGIN?.replace(/\/$/, '')
  if (!appOrigin) throw new Error('attached: set FLING_E2E_ORIGIN to the running instance')
  return { name: 'attached (an instance already running, with dev login)', appOrigin }
}

async function waitForHealth(
  origin: string,
  child: ChildProcess | undefined,
  output: () => string
) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null)
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
function stop(child: ChildProcess | undefined) {
  if (!child || child.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

async function run(runtime: Runtime): Promise<boolean> {
  console.log(`\n${runtime.name}: ${runtime.appOrigin}`)
  const state = mkdtempSync(join(tmpdir(), 'fling-e2e-state-'))
  const child = runtime.start?.(state)
  let output = ''
  child?.stdout?.on('data', d => {
    output += d
  })
  child?.stderr?.on('data', d => {
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

async function nodeRuntime(): Promise<Runtime> {
  const port = await freePort()
  const host = `flingnode.lvh.me:${port}`
  return {
    name: 'node (the Node host: PGlite, fs blobs)',
    appOrigin: `http://${host}`,
    start: state =>
      spawn(tsx, [join(REPO, 'platforms', 'node', 'src', 'main.ts')], {
        cwd: REPO,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          APP_ENV: 'development',
          DEV_LOGIN: '1',
          PORT: String(port),
          APP_ORIGIN: `http://${host}`,
          SITES_DOMAIN: host,
          SITE_SCHEME: 'http',
          SITE_COOKIE_DOMAIN: 'flingnode.lvh.me',
          LIVE_URL: `ws://${host}/api/live`,
          FS_ROOT: state,
          SESSION_SECRET: secret(),
          SITE_HMAC_KEY: secret(),
          SITE_SECRETS_KEY: randomBytes(32).toString('hex'),
          MAIL_DRIVER: 'memory',
          MAIL_FROM: 'fling@mail.flingnode.lvh.me',
          INVITES: 'on',
          SERVERS: 'members',
          ...ARCHIVE_POLICY,
        },
      }),
  }
}

const RUNTIMES: Record<string, () => Promise<Runtime>> = {
  aws: awsRuntime,
  cloudflare: cloudflareRuntime,
  node: nodeRuntime,
}
const ATTACHED: Record<string, () => Promise<Runtime>> = { attached: attachedRuntime }
const ALL = { ...RUNTIMES, ...ATTACHED }

const wanted = process.argv.slice(2).filter(a => !a.startsWith('-'))
const names = wanted.length ? wanted : Object.keys(RUNTIMES)
for (const name of names) {
  if (!ALL[name]) {
    console.error(`unknown runtime ${name} (${Object.keys(ALL).join(', ')})`)
    process.exit(2)
  }
}
// Ctrl-C: exit, so the 'exit' handlers stop whatever is running.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(130))
let failed = 0
for (const name of names) {
  const make = ALL[name] as () => Promise<Runtime>
  if (!(await run(await make()))) failed++
}
process.exit(failed ? 1 : 0)
