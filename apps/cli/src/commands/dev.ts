/**
 * `fling dev [dir] [--as <email> [--guest]] [--port <n>] [--spa]`: serve a folder the way its site
 * will be served, with its site server running beside it and rebuilt on save (dev-server.ts), until
 * Ctrl-C. Needs no sign-in: nothing leaves the computer.
 *
 * It prints where it serves, the server's entry, the viewer and which declared secrets it found
 * in `.env` / `.env.local` (a missing one is a warning, the local `secrets_missing`), then every
 * request line and everything the server prints, as `fling logs` does.
 */
import { stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { formatLogLine } from '@fling/shared'
import chalk from 'chalk'
import type { CommandContext } from '../context.ts'
import { type DevServer, type DevStatus, startDevServer } from '../dev-server.ts'
import { CliError } from '../errors.ts'

export interface DevCommandOptions {
  as?: string
  guest?: boolean
  port?: string
  spa?: boolean
}

/** The lines `fling dev` starts with. */
export function describeDev(status: DevStatus): string[] {
  const where = `serving ${basename(status.dir)}/ at ${status.url}`
  const server = status.server
    ? `  (server: ${status.server}${status.server.endsWith('.mjs') ? '' : ', rebuilt on save'})`
    : '  (static files only: no server.ts, server.js or _fling/server.mjs)'
  const viewer = status.viewer
    ? `viewer: ${status.viewer.email}${status.viewer.guest ? ' (a guest)' : ''} (${status.viewer.id})`
    : 'viewer: none, as on a public site (--as <email> to sign in)'
  const secrets = status.secrets.length
    ? `secrets: ${status.secrets.map(s => `${s.name} (from ${s.from})`).join(', ')}`
    : 'secrets: none'
  return [`${where}${server}`, status.server ? `${viewer} · ${secrets}` : viewer]
}

export async function runDev(
  ctx: CommandContext,
  input: string | undefined,
  opts: DevCommandOptions,
  /** for tests: called with the running server instead of waiting for Ctrl-C */
  running?: (dev: DevServer) => Promise<void>
): Promise<void> {
  const dir = resolve(input ?? '.')
  const found = await stat(dir).catch(() => null)
  if (!found?.isDirectory()) throw new CliError(`Not a folder: ${input ?? '.'}`)
  if (opts.guest && !opts.as) throw new CliError('--guest needs --as <email>')
  if (opts.as !== undefined && !/^[^@\s]+@[^@\s]+$/.test(opts.as)) {
    throw new CliError(`--as takes an email address, not "${opts.as}"`)
  }
  const port = opts.port === undefined ? undefined : Number(opts.port)
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new CliError(`Invalid --port "${opts.port}"`)
  }
  const dev = await startDevServer({
    dir,
    ...(port === undefined ? {} : { port }),
    ...(opts.as ? { as: opts.as } : {}),
    guest: opts.guest,
    spa: opts.spa,
    onLog: line => ctx.out.text(formatLogLine(line)),
    onNote: n =>
      n.level === 'error'
        ? ctx.log.error(n.text)
        : n.level === 'warn'
          ? ctx.log.warn(n.text)
          : ctx.log.info(n.text),
  })
  const status = dev.status()
  const [first, second] = describeDev(status)
  ctx.log.info(first as string)
  ctx.log.hint(second as string)
  if (status.missing.length) {
    ctx.log.warn(
      `Not in .env or .env.local: ${status.missing.join(', ')}. The server runs without ${status.missing.length === 1 ? 'it' : 'them'}; a deploy waits until ${status.missing.length === 1 ? "it's" : "they're"} set (\`${ctx.binName} secrets set\`).`
    )
  }
  ctx.log.hint(devHint(ctx.binName))
  if (ctx.json) ctx.out.data(status, () => '')
  if (running) {
    try {
      await running(dev)
    } finally {
      await dev.close()
    }
    return
  }
  await new Promise<void>(done => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      done()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
  await dev.close()
}

const devHint = (bin: string) =>
  chalk.dim(`Try it with the page or curl, then \`${bin} deploy\`. Ctrl-C stops it.`)
