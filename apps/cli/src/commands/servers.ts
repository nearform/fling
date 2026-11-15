/**
 * A site's server from the terminal (the `servers` capability; site-server.ts):
 *
 *   fling secrets set <site> NAME            the value from stdin (asked, unechoed, on a terminal)
 *   fling secrets set <site> --from .env NAME…  only the named keys of that file, nothing else
 *   fling secrets ls <site>                  names, who set each and when, and what's missing
 *   fling secrets rm <site> NAME
 *   fling logs <site> [--since 1h] [--follow]   the server's log; --follow polls every 2 s
 *
 * A value never goes on the command line, where it would land in shell history: `NAME=value` is
 * refused. Setting or removing a secret redeploys (the live server restarts with it and is probed;
 * a deploy that waited for secrets goes live once the last is set): the outcome is printed, with
 * the server's log when it didn't start.
 */
import {
  formatLogLine,
  isReservedSecretName,
  RESERVED_SECRET_NAMES_TEXT,
  SITE_SECRET_NAME_RE,
} from '@fling/shared'
import chalk from 'chalk'
import { type CommandContext, requireClient } from '../context.ts'
import { pickEnv } from '../dotenv.ts'
import { CliError } from '../errors.ts'
import { loadInstanceWith } from '../instance.ts'
import {
  checkSince,
  describeSecretOutcome,
  listSecrets,
  newLogLines,
  readLogs,
  removeSecret,
  serversEnabled,
  setSecret,
} from '../site-server.ts'
import { renderTable } from '../utils/output.ts'

/** The instance's name, after checking it runs site servers (asked again if the stored copy predates them). */
async function serversOn(ctx: CommandContext): Promise<string> {
  const instance = await loadInstanceWith(ctx.store, ctx.config, ctx.fetch, 'servers')
  if (serversEnabled(instance) === false) {
    throw new CliError(`${instance?.name ?? 'This Fling'} doesn't run site servers`, {
      hint: 'Site secrets and logs are for sites with a server, on a Fling whose admins turned servers on.',
    })
  }
  return instance?.name ?? 'this Fling'
}

function checkName(name: string): string {
  if (name.includes('=')) {
    throw new CliError('A secret value never goes on the command line', {
      hint: 'Pass the name only, and the value on stdin (`fling secrets set my-site NAME < file`) or with --from .env NAME.',
    })
  }
  if (!SITE_SECRET_NAME_RE.test(name)) {
    throw new CliError(`Invalid secret name "${name}"`, {
      hint: 'Use A-Z, 0-9 and _, not starting with a digit, at most 64 (e.g. SLACK_WEBHOOK_URL).',
    })
  }
  if (isReservedSecretName(name)) {
    throw new CliError(`A site secret can't be called ${name}`, {
      hint: `${RESERVED_SECRET_NAMES_TEXT} are Fling's and the platform's: choose another name, in fling.json and the server too.`,
    })
  }
  return name
}

/** A value from stdin: one trailing newline (from `echo` or an editor) is not part of it. */
async function valueFromStdin(ctx: CommandContext, name: string): Promise<string> {
  const piped = await (ctx.readStdin?.() ?? Promise.resolve(null))
  if (piped !== null) return piped.replace(/\r?\n$/, '')
  if (!ctx.interactive || !ctx.promptSecret) {
    throw new CliError(`No value for ${name} on stdin`, {
      hint: `Pipe it in (\`${ctx.binName} secrets set <site> ${name} < file\`) or use --from .env ${name}.`,
    })
  }
  return ctx.promptSecret(`Value for ${name} (not shown)`)
}

export async function runSecretsSet(
  ctx: CommandContext,
  site: string,
  names: string[],
  opts: { from?: string }
): Promise<void> {
  for (const n of names) checkName(n)
  if (names.length === 0) throw new CliError('Name the secret to set, e.g. SLACK_WEBHOOK_URL')
  if (opts.from === undefined && names.length > 1) {
    throw new CliError('Set one secret at a time from stdin, or several with --from <file>')
  }
  const instanceName = await serversOn(ctx)
  const client = requireClient(ctx)
  const values =
    opts.from === undefined
      ? { [names[0] as string]: await valueFromStdin(ctx, names[0] as string) }
      : await pickEnv(opts.from, names)
  const results = []
  let failed = false
  for (const name of names) {
    const value = values[name] as string
    if (value === '') throw new CliError(`The value for ${name} is empty`)
    const res = await setSecret(client, site, name, value, instanceName)
    const from = opts.from === undefined ? 'from stdin' : `from ${opts.from}; nothing else read`
    ctx.log.success(`${name} set on ${site} ${chalk.dim(`(${from})`)}`)
    const outcome = describeSecretOutcome(site, res)
    for (const line of outcome.lines) (outcome.failed ? ctx.log.warn : ctx.log.info)(line)
    for (const line of outcome.logs) ctx.log.hint(line)
    failed ||= outcome.failed
    results.push(res)
  }
  if (ctx.json) ctx.out.data({ site, secrets: results }, () => '')
  if (failed) process.exitCode = 1
}

export async function runSecretsList(ctx: CommandContext, site: string): Promise<void> {
  const instanceName = await serversOn(ctx)
  const res = await listSecrets(requireClient(ctx), site, instanceName)
  ctx.out.data(res, () => {
    const table = renderTable(res.secrets, [
      { header: 'NAME', value: s => s.name },
      { header: 'SET BY', value: s => s.setBy },
      { header: 'WHEN', value: s => ago(s.setAt) },
    ])
    const missing = res.missing.length
      ? `\n${chalk.yellow(`The live version declares in fling.json but not set: ${res.missing.join(', ')}`)}`
      : ''
    const w = res.waiting
    const waiting = !w
      ? ''
      : w.missing.length
        ? `\n${chalk.yellow(`Version ${w.versionId} waits for ${w.missing.join(', ')} (it declares ${w.declared.join(', ')}): it goes live once they are set`)}`
        : `\n${chalk.yellow(`Version ${w.versionId} waits to go live: its server didn't start with the secrets it declares (${w.declared.join(', ')}). Setting or removing a secret tries it again`)}`
    return `${table}${missing}${waiting}`
  })
}

export async function runSecretsRemove(
  ctx: CommandContext,
  site: string,
  name: string
): Promise<void> {
  checkName(name)
  const instanceName = await serversOn(ctx)
  const res = await removeSecret(requireClient(ctx), site, name, instanceName)
  ctx.log.success(`${name} removed from ${site}`)
  const outcome = describeSecretOutcome(site, res, true)
  for (const line of outcome.lines) (outcome.failed ? ctx.log.warn : ctx.log.info)(line)
  for (const line of outcome.logs) ctx.log.hint(line)
  if (ctx.json) ctx.out.data(res, () => '')
  if (outcome.failed) process.exitCode = 1
}

/** How often --follow asks for new lines. */
export const FOLLOW_INTERVAL_MS = 2000

export async function runLogs(
  ctx: CommandContext,
  site: string,
  opts: {
    since?: string
    follow?: boolean
    /** for tests: stop following after this many polls */
    polls?: number
    sleep?: (ms: number) => Promise<void>
  }
): Promise<void> {
  const since = checkSince(opts.since ?? '1h')
  const instanceName = await serversOn(ctx)
  const client = requireClient(ctx)
  const seen = new Set<string>()
  const lines = newLogLines(seen, await readLogs(client, site, { since }, instanceName))
  const print = (batch: typeof lines) => {
    if (ctx.json) for (const line of batch) ctx.out.data(line, () => '')
    else for (const line of batch) ctx.out.text(formatLogLine(line))
  }
  if (!opts.follow) {
    if (ctx.json) ctx.out.data({ lines }, () => '')
    else if (lines.length === 0) ctx.log.info(`No log lines for ${site} since ${since}`)
    else print(lines)
    return
  }
  print(lines)
  let last = lines.at(-1)?.at ?? new Date().toISOString()
  const sleep = opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  for (let n = 0; opts.polls === undefined || n < opts.polls; n++) {
    await sleep(FOLLOW_INTERVAL_MS)
    const next = newLogLines(seen, await readLogs(client, site, { since: last }, instanceName))
    print(next)
    last = next.at(-1)?.at ?? last
  }
}

/** `2 minutes ago` */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (Number.isNaN(s)) return iso
  const unit = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'} ago`
  if (s < 60) return 'just now'
  if (s < 3600) return unit(Math.floor(s / 60), 'minute')
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour')
  return unit(Math.floor(s / 86400), 'day')
}
