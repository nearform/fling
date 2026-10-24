// Run the Worker locally under `wrangler dev`, with local D1, R2 and KV, ready to use:
//   1. dist/assets (the web UI and the sites' 404 page; build apps/web first),
//   2. the D1 schema (`wrangler d1 migrations apply --local`) and Fling's data migrations
//      (scripts/migrate.ts --local), as a deploy runs them,
//   3. `wrangler dev`: the app at http://flingcf.lvh.me:<port>, sites at
//      http://<name>.flingcf.lvh.me:<port> (lvh.me resolves to 127.0.0.1), dev login on.
//
//   node scripts/dev.mjs [--port 47103] [--persist-to .wrangler/state] [--test-scheduled]
//
// Secrets: SESSION_SECRET and SITE_HMAC_KEY from the environment when both are set (the e2e),
// else from .dev.vars, created with random values the first time.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ROOT } from './config.mjs'

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '47103' },
    'persist-to': { type: 'string', default: '.wrangler/state' },
    'inspector-port': { type: 'string' },
    'test-scheduled': { type: 'boolean', default: false },
  },
})

const bin = name => join(ROOT, 'node_modules', '.bin', name)
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' }
const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: ROOT, stdio: 'inherit', env })
const persistTo = resolve(ROOT, args['persist-to'])
const host = `flingcf.lvh.me:${args.port}`

run(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--assets-only'])
run(bin('wrangler'), ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo])
run(bin('tsx'), [join(ROOT, 'scripts', 'migrate.ts'), '--local', '--persist-to', persistTo])

const vars = { APP_ORIGIN: `http://${host}`, SITES_DOMAIN: host }
if (process.env.SESSION_SECRET && process.env.SITE_HMAC_KEY) {
  vars.SESSION_SECRET = process.env.SESSION_SECRET
  vars.SITE_HMAC_KEY = process.env.SITE_HMAC_KEY
} else if (!existsSync(join(ROOT, '.dev.vars'))) {
  const secret = () => randomBytes(32).toString('base64url')
  writeFileSync(
    join(ROOT, '.dev.vars'),
    `# Local secrets for wrangler dev (gitignored).\nSESSION_SECRET=${secret()}\nSITE_HMAC_KEY=${secret()}\n`
  )
}

const child = spawn(
  bin('wrangler'),
  [
    'dev',
    '--port',
    args.port,
    '--ip',
    '127.0.0.1',
    '--persist-to',
    persistTo,
    '--show-interactive-dev-session=false',
    ...(args['inspector-port'] ? ['--inspector-port', args['inspector-port']] : []),
    ...(args['test-scheduled'] ? ['--test-scheduled'] : []),
    ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
  ],
  { cwd: ROOT, stdio: 'inherit', env }
)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => process.exit(code ?? 0))
