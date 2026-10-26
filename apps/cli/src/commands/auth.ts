/**
 * `fling login [url] | use [url] | logout [url] | whoami`. The CLI remembers every server it signs
 * in to (config.ts); one is current, and `--server` / FLING_URL pick another for one command.
 */
import chalk from 'chalk'
import { loginFlow } from '../auth.ts'
import { matchServer, redactKey } from '../config.ts'
import { type CommandContext, requireClient, requireServer } from '../context.ts'
import { CliError } from '../errors.ts'
import { loadInstance } from '../instance.ts'
import { sitesBaseOf, sitesPattern, whoami } from '../sites.ts'

/**
 * `fling login <url>` → that server (a remembered one may be named by its host); bare
 * `fling login` → --server, FLING_URL or the current one.
 */
export async function loginServer(ctx: CommandContext, url: string | undefined): Promise<string> {
  if (url === undefined) return requireServer(ctx)
  const { servers } = await ctx.store.load()
  return matchServer(Object.keys(servers), url).url
}

/** Sign in to a server and make it current; the other servers' logins are kept. */
export async function runLogin(ctx: CommandContext, url?: string): Promise<void> {
  const result = await loginFlow({
    serverUrl: await loginServer(ctx, url),
    store: ctx.store,
    log: ctx.log,
    open: ctx.open,
    fetch: ctx.fetch,
    makeCurrent: true,
  })
  if (ctx.json) ctx.out.data(result, () => '')
}

/** `fling use <url>` makes a remembered server current; bare `fling use` lists them. */
export async function runUse(ctx: CommandContext, url?: string): Promise<void> {
  const config = await ctx.store.load()
  const urls = Object.keys(config.servers)
  const overridden =
    ctx.config.serverUrlSource === 'env' || ctx.config.serverUrlSource === 'flag'
      ? ctx.config.serverUrl
      : undefined
  const overrideHint = () => {
    if (overridden)
      ctx.log.hint(
        `${ctx.config.serverUrlSource === 'env' ? 'FLING_URL' : '--server'} is set: commands run with it use ${overridden}.`
      )
  }

  if (url === undefined) {
    const servers = urls.map(server => {
      const entry = config.servers[server] ?? {}
      return {
        url: server,
        current: server === config.current,
        instance: entry.instance?.name ?? null,
        email: entry.apiKey ? (entry.user?.email ?? null) : null,
        signedIn: Boolean(entry.apiKey),
      }
    })
    if (servers.length === 0 && !ctx.json) {
      ctx.log.info('No Fling servers yet')
      ctx.log.hint(`Run \`${ctx.binName} login <url>\` with your Fling's address.`)
      return
    }
    const width = Math.max(...servers.map(s => s.url.length))
    ctx.out.data({ current: config.current ?? null, servers }, () =>
      servers
        .map(s =>
          [
            s.current ? chalk.bold('*') : ' ',
            s.current ? chalk.bold(s.url.padEnd(width)) : s.url.padEnd(width),
            s.instance ?? chalk.dim('(unknown)'),
            s.signedIn ? (s.email ?? chalk.dim('(signed in)')) : chalk.dim('(signed out)'),
          ].join('  ')
        )
        .join('\n')
    )
    if (!ctx.json) {
      ctx.log.hint(`* = current. Switch with \`${ctx.binName} use <url>\`.`)
      overrideHint()
    }
    return
  }

  const match = matchServer(urls, url, { loose: true })
  if (!match.remembered)
    throw new CliError(`Not signed in to ${match.url} on this computer`, {
      hint: `Run \`${ctx.binName} login ${match.url}\` to add it, or \`${ctx.binName} use\` to list your servers.`,
    })
  await ctx.store.setCurrent(match.url)
  const entry = config.servers[match.url] ?? {}
  const name = entry.instance?.name
  const email = entry.apiKey ? entry.user?.email : undefined
  ctx.out.data(
    { current: match.url, instance: name ?? null, email: email ?? null },
    () => `Now using ${chalk.bold(match.url)}${name ? chalk.dim(` (${name})`) : ''}`
  )
  if (!ctx.json) {
    if (entry.apiKey) ctx.log.hint(`Signed in as ${email ?? 'an unknown user'}.`)
    else ctx.log.hint(`Signed out there: run \`${ctx.binName} login\` to sign in.`)
    overrideHint()
  }
}

/**
 * Remove a server's API key from this computer (default: the server this command uses). The
 * current server is kept, so a bare `fling login` signs in to it again; any other is forgotten.
 */
export async function runLogout(ctx: CommandContext, url?: string): Promise<void> {
  const config = await ctx.store.load()
  const target =
    url === undefined
      ? ctx.config.serverUrl
      : matchServer(Object.keys(config.servers), url, { loose: true }).url
  const entry = target === undefined ? undefined : config.servers[target]
  if (target === undefined || entry === undefined) {
    ctx.log.info(`Not logged in${target ? ` to ${target}` : ''} — nothing to do`)
    return
  }
  if (target === config.current) {
    if (!entry.apiKey) {
      ctx.log.info('Not logged in — nothing to do')
      return
    }
    await ctx.store.clearCredentials(target)
    ctx.log.success('Logged out; API key removed from this machine')
  } else {
    await ctx.store.removeServer(target)
    ctx.log.success(
      entry.apiKey
        ? `Logged out of ${target}; API key and server removed from this machine`
        : `Removed ${target} from this machine`
    )
  }
  if (entry.apiKey) ctx.log.hint(`Revoke it on the server under Connections at ${target}`)
}

export async function runWhoami(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const me = await whoami(client)
  const instance = await loadInstance(ctx.store, ctx.config, ctx.fetch)
  const { serverUrl, current } = ctx.config
  const others = Object.keys((await ctx.store.load()).servers).filter(s => s !== serverUrl)
  ctx.out.data(
    {
      ...me,
      serverUrl,
      serverUrlSource: ctx.config.serverUrlSource,
      current: current ?? null,
      instance: instance?.name ?? null,
      apiKey: redactKey(ctx.config.apiKey),
      apiKeySource: ctx.config.apiKeySource,
    },
    () =>
      [
        `${chalk.bold('User:')}    ${me.name} <${me.email}>`,
        `${chalk.bold('Sites:')}   ${sitesPattern(sitesBaseOf(instance))} ${chalk.dim('(names are first come, first served)')}`,
        `${chalk.bold('Server:')}  ${serverUrl}${instance ? chalk.dim(` (${instance.name})`) : ''} ${chalk.dim(
          serverUrl === current
            ? '(current)'
            : `(from ${ctx.config.serverUrlSource === 'env' ? 'FLING_URL' : '--server'}; current: ${current ?? 'none'})`
        )}`,
        `${chalk.bold('API key:')} ${redactKey(ctx.config.apiKey)} ${chalk.dim(`(from ${ctx.config.apiKeySource})`)}`,
        ...(others.length > 0
          ? [
              chalk.dim(
                `${others.length} other server${others.length === 1 ? '' : 's'} on this computer: \`${ctx.binName} use\` lists them`
              ),
            ]
          : []),
      ].join('\n')
  )
}
