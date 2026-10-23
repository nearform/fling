/** `fling login | logout | whoami`. */
import chalk from 'chalk'
import { loginFlow } from '../auth.ts'
import { redactKey } from '../config.ts'
import { type CommandContext, requireClient } from '../context.ts'
import { discoverSitesBase, sitesPattern, whoami } from '../sites.ts'

export async function runLogin(ctx: CommandContext): Promise<void> {
  const result = await loginFlow({
    serverUrl: ctx.config.serverUrl,
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
  ctx.log.hint(`Revoke it on the server under API keys at ${ctx.config.serverUrl}`)
}

export async function runWhoami(ctx: CommandContext): Promise<void> {
  const client = requireClient(ctx)
  const me = await whoami(client)
  const base = ctx.json ? null : await discoverSitesBase(client)
  ctx.out.data(
    {
      ...me,
      serverUrl: ctx.config.serverUrl,
      apiKey: redactKey(ctx.config.apiKey),
      apiKeySource: ctx.config.apiKeySource,
    },
    () =>
      [
        `${chalk.bold('User:')}    ${me.name} <${me.email}>`,
        `${chalk.bold('Sites:')}   ${sitesPattern(base)} ${chalk.dim('(names are first come, first served)')}`,
        `${chalk.bold('Server:')}  ${ctx.config.serverUrl}`,
        `${chalk.bold('API key:')} ${redactKey(ctx.config.apiKey)} ${chalk.dim(`(from ${ctx.config.apiKeySource})`)}`,
      ].join('\n')
  )
}
