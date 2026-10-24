/** `fling login [url] | logout | whoami`. */
import chalk from 'chalk'
import { loginFlow } from '../auth.ts'
import { normalizeServerUrl, redactKey } from '../config.ts'
import { type CommandContext, requireClient, requireServer } from '../context.ts'
import { CliError } from '../errors.ts'
import { loadInstance } from '../instance.ts'
import { sitesBaseOf, sitesPattern, whoami } from '../sites.ts'

/** `fling login <url>` → that server; bare `fling login` → --server, FLING_URL or the stored one. */
export function loginServer(ctx: CommandContext, url: string | undefined): string {
  if (url === undefined) return requireServer(ctx)
  try {
    return normalizeServerUrl(url)
  } catch {
    throw new CliError(`"${url}" is not a server address`, {
      hint: `Run \`${ctx.binName} login <url>\` with your Fling's address, e.g. https://fling.example.com.`,
    })
  }
}

export async function runLogin(ctx: CommandContext, url?: string): Promise<void> {
  const result = await loginFlow({
    serverUrl: loginServer(ctx, url),
    store: ctx.store,
    log: ctx.log,
    open: ctx.open,
    fetch: ctx.fetch,
  })
  if (ctx.json) ctx.out.data(result, () => '')
}

export async function runLogout(ctx: CommandContext): Promise<void> {
  const config = await ctx.store.load()
  if (!config.apiKey) {
    ctx.log.info('Not logged in — nothing to do')
    return
  }
  await ctx.store.clearCredentials()
  ctx.log.success('Logged out; API key removed from this machine')
  if (ctx.config.serverUrl)
    ctx.log.hint(`Revoke it on the server under Connections at ${ctx.config.serverUrl}`)
}

export async function runWhoami(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const me = await whoami(client)
  const instance = await loadInstance(ctx.store, ctx.config, ctx.fetch)
  ctx.out.data(
    {
      ...me,
      serverUrl: ctx.config.serverUrl,
      instance: instance?.name ?? null,
      apiKey: redactKey(ctx.config.apiKey),
      apiKeySource: ctx.config.apiKeySource,
    },
    () =>
      [
        `${chalk.bold('User:')}    ${me.name} <${me.email}>`,
        `${chalk.bold('Sites:')}   ${sitesPattern(sitesBaseOf(instance))} ${chalk.dim('(names are first come, first served)')}`,
        `${chalk.bold('Server:')}  ${ctx.config.serverUrl}${instance ? chalk.dim(` (${instance.name})`) : ''}`,
        `${chalk.bold('API key:')} ${redactKey(ctx.config.apiKey)} ${chalk.dim(`(from ${ctx.config.apiKeySource})`)}`,
      ].join('\n')
  )
}
