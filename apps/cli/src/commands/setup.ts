/**
 * `fling setup [url] [--yes] [--scope user|project|local]` — get a machine ready in one go:
 *
 *   1. Sign in, to the Fling at `url` (needed the first time: there is no default server); skipped
 *      when the stored key for that server still works, in which case its `/.well-known/fling` is
 *      read again (best effort), so the stored copy, and the release the update check compares
 *      with, are current. Either way it becomes the current server, and the logins to other
 *      servers are kept.
 *   2. Claude Code: install the Fling plugin (skill + MCP server) through the `claude` CLI or, when
 *      it is already installed, refresh the marketplace and update the plugin, saying which version
 *      it went from and to. Skipped, with a hint, when `claude` is missing.
 *   3. Claude Desktop (macOS / Windows, when it is installed): download the fling.mcpb of this
 *      CLI's version (`extensionSources`) and open it; Desktop then asks the user to confirm the
 *      install, which replaces an older copy in place.
 *
 * On a terminal it asks before installing the plugin and before step 3; with `--yes` or without a
 * terminal it does them all. Refreshing an installed plugin needs no question. Steps report and
 * carry on: one failing doesn't stop the others; the exit code is 1 if any did, except a failed
 * plugin refresh, which leaves the installed plugin working and is only reported.
 */
import { intro, outro, spinner } from '@clack/prompts'
import { instanceGuideUrl } from '@fling/shared'
import chalk from 'chalk'
import {
  claudeCodeStatus,
  downloadExtension,
  extensionSources,
  findClaudeDesktop,
  installPlugin,
  MARKETPLACE_SOURCE,
  PLUGIN_ID,
  PLUGIN_NAME,
  type PluginScope,
  type RunClaude,
  runClaude,
  updatePlugin,
} from '../claude.ts'
import { type CommandContext, requireClient, requireServer } from '../context.ts'
import { CliError, exitCodeFor } from '../errors.ts'
import { fetchInstance } from '../instance.ts'
import { whoami } from '../sites.ts'
import { logo } from '../ui/theme.ts'
import { createLogger } from '../utils/logger.ts'
import { loginServer, runLogin } from './auth.ts'

export interface SetupOptions {
  yes?: boolean
  scope?: string
  /** The Fling to sign in to; default: the current one. */
  url?: string
}

export interface SetupDeps {
  runClaude?: RunClaude
  findClaudeDesktop?: () => Promise<string | null>
  /** Download fling.mcpb from a URL; returns the file's path. */
  downloadExtension?: (url: string) => Promise<string>
}

type StepResult = 'done' | 'updated' | 'already' | 'skipped' | 'missing' | 'failed'

const SCOPES: readonly PluginScope[] = ['user', 'project', 'local']

export async function runSetup(
  baseCtx: CommandContext,
  opts: SetupOptions,
  deps: SetupDeps = {}
): Promise<void> {
  const scope = (opts.scope ?? 'user') as PluginScope
  if (!SCOPES.includes(scope))
    throw new CliError(`--scope must be one of ${SCOPES.join(', ')}, not "${opts.scope}"`)
  const run = deps.runClaude ?? runClaude
  const ask = baseCtx.interactive && !opts.yes
  const fancy = baseCtx.interactive && !baseCtx.json
  // Inside clack's intro/outro frame, keep log lines on its │ gutter.
  const ctx: CommandContext = fancy
    ? {
        ...baseCtx,
        log: createLogger({
          debug: baseCtx.config.debug,
          write: line => process.stderr.write(`${chalk.gray('│')}  ${line}\n`),
        }),
      }
    : baseCtx

  if (fancy) {
    process.stderr.write(`${logo()}\n`)
    intro(chalk.bold(' fling setup '), { output: process.stderr })
  }

  const login = await stepLogin(ctx, opts.url)
  const results: Record<'login' | 'claudeCode' | 'claudeDesktop', StepResult> = {
    login: login.result,
    claudeCode: 'skipped',
    claudeDesktop: 'skipped',
  }
  // The later steps use the server signed in to, with what the login stored.
  const after: CommandContext = login.serverUrl
    ? { ...ctx, config: await ctx.store.resolve({ serverUrl: login.serverUrl }) }
    : ctx
  results.claudeCode = await stepClaudeCode(after, run, scope, ask, fancy)
  results.claudeDesktop = await stepClaudeDesktop(after, deps, ask, fancy)

  const failed = Object.values(results).includes('failed')
  const guide = instanceGuideUrl(
    login.serverUrl ? (await ctx.store.resolve({ serverUrl: login.serverUrl })).instance : undefined
  )
  if (fancy)
    outro(
      failed
        ? chalk.yellow('Setup finished with problems — see above, then run `fling setup` again.')
        : `You're set. Try ${chalk.bold(`${ctx.binName} deploy ./dist`)}, or ask Claude to “fling this”.${
            guide ? `\nHow everything works: ${chalk.underline(guide)}` : ''
          }`,
      { output: process.stderr }
    )
  ctx.out.data(results, () => '')
  if (failed) process.exitCode = 1
}

/**
 * Sign in to `url` (default: the server this command uses) unless its stored key still works.
 * Either way the server becomes current. Returns the server, when there is one.
 */
async function stepLogin(
  ctx: CommandContext,
  url: string | undefined
): Promise<{ result: StepResult; serverUrl?: string }> {
  let serverUrl: string
  let target: CommandContext
  try {
    serverUrl = await loginServer(ctx, url)
    target = { ...ctx, config: await ctx.store.resolve({ serverUrl }) }
  } catch (error) {
    ctx.log.error(error instanceof Error ? error.message : String(error))
    return { result: 'failed' }
  }
  return { result: await signIn(target, serverUrl), serverUrl }
}

async function signIn(ctx: CommandContext, serverUrl: string): Promise<StepResult> {
  if (ctx.config.apiKey) {
    try {
      const me = await whoami(requireClient(ctx))
      if (ctx.config.remembered) await ctx.store.setCurrent(serverUrl)
      ctx.log.success(`Signed in as ${chalk.bold(me.name)} ${chalk.dim(`<${me.email}>`)}`)
      if (ctx.config.remembered)
        await fetchInstance(serverUrl, ctx.fetch)
          .then(instance => ctx.store.putServer(serverUrl, { instance }, { makeCurrent: false }))
          .catch(() => {})
      return 'already'
    } catch (error) {
      if (exitCodeFor(error) !== 2) {
        ctx.log.error(error instanceof Error ? error.message : String(error))
        return 'failed'
      }
      ctx.log.warn('The stored API key no longer works — signing in again')
    }
  }
  try {
    // runLogin prints JSON under --json; setup prints one summary instead.
    await runLogin({ ...ctx, json: false }, serverUrl)
    return 'done'
  } catch (error) {
    ctx.log.error(error instanceof Error ? error.message : String(error))
    return 'failed'
  }
}

async function stepClaudeCode(
  ctx: CommandContext,
  run: RunClaude,
  scope: PluginScope,
  ask: boolean,
  fancy: boolean
): Promise<StepResult> {
  const status = await claudeCodeStatus(run)
  if (status.claude === 'missing') {
    ctx.log.info(`Claude Code not found ${chalk.dim('(no `claude` on your PATH) — skipped')}`)
    ctx.log.hint(
      `Once it is installed, run \`${ctx.binName} setup\` again, or in Claude Code: /plugin marketplace add ${MARKETPLACE_SOURCE} then /plugin install ${PLUGIN_ID}`
    )
    return 'missing'
  }

  if ('installed' in status && status.installed) return refreshPlugin(ctx, run, status, fancy)

  if (
    ask &&
    !(await ctx.confirm('Install the Fling plugin (skill + MCP server) into Claude Code?'))
  ) {
    ctx.log.info(chalk.dim('Claude Code plugin: skipped'))
    return 'skipped'
  }
  const s = fancy ? spinner({ output: process.stderr }) : null
  s?.start('Installing the Claude Code plugin')
  try {
    await installPlugin(run, scope)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (s) s.error(message)
    else ctx.log.error(message)
    return 'failed'
  }
  const done = `Claude Code plugin ${PLUGIN_NAME} installed ${chalk.dim(`(${scope} scope)`)}`
  if (s) s.stop(done)
  else ctx.log.success(done)
  ctx.log.hint('Restart Claude Code (or run /reload-plugins) to pick it up.')
  return 'done'
}

/**
 * Refresh the marketplace and update the installed plugin, then say what changed: the versions
 * before and after, read from `claude plugin list`. A failure is reported as a warning: the
 * installed plugin still works.
 */
async function refreshPlugin(
  ctx: CommandContext,
  run: RunClaude,
  before: { version?: string; scope?: string },
  fancy: boolean
): Promise<StepResult> {
  const s = fancy ? spinner({ output: process.stderr }) : null
  s?.start('Updating the Claude Code plugin')
  try {
    await updatePlugin(run, before.scope)
  } catch (error) {
    const message = `${error instanceof Error ? error.message : String(error)} — the installed plugin${before.version ? ` (${before.version})` : ''} is unchanged`
    if (s) s.stop(chalk.yellow(message))
    else ctx.log.warn(message)
    return 'already'
  }
  const after = await claudeCodeStatus(run).catch(() => null)
  const version = after && 'installed' in after && after.installed ? after.version : undefined
  const unchanged = before.version !== undefined && version === before.version
  const done = unchanged
    ? `Claude Code plugin ${PLUGIN_NAME} is up to date ${chalk.dim(`(${version})`)}`
    : before.version && version
      ? `Claude Code plugin ${PLUGIN_NAME} updated from ${before.version} to ${version}`
      : `Claude Code plugin ${PLUGIN_NAME} updated${version ? ` to ${version}` : ''}`
  if (s) s.stop(done)
  else ctx.log.success(done)
  if (unchanged) return 'already'
  ctx.log.hint('Restart Claude Code (or run /reload-plugins) to pick up the new version.')
  return 'updated'
}

async function stepClaudeDesktop(
  ctx: CommandContext,
  deps: SetupDeps,
  ask: boolean,
  fancy: boolean
): Promise<StepResult> {
  const app = await (deps.findClaudeDesktop ?? findClaudeDesktop)()
  if (!app) return 'missing'
  if (ask && !(await ctx.confirm('Add the Fling extension to Claude Desktop too?'))) {
    ctx.log.info(chalk.dim('Claude Desktop extension: skipped'))
    return 'skipped'
  }
  const s = fancy ? spinner({ output: process.stderr }) : null
  s?.start('Downloading the Claude Desktop extension')
  const download = deps.downloadExtension ?? (url => downloadExtension(url, ctx.fetch))
  try {
    const sources = extensionSources(requireServer(ctx), ctx.config.instance?.release)
    let got: { file: string; version?: string } | undefined
    let lastError: unknown
    for (const source of sources) {
      try {
        got = { file: await download(source.url), version: source.version }
        break
      } catch (error) {
        lastError = error
        ctx.log.debug(`Could not download ${source.url}: ${String(error)}`)
      }
    }
    if (!got) throw lastError
    await ctx.open(got.file)
    const done = `Opened fling.mcpb${got.version ? ` ${got.version}` : ''} in Claude Desktop — click Install there to finish (it replaces an older version)`
    if (s) s.stop(done)
    else ctx.log.success(done)
    return 'done'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (s) s.error(message)
    else ctx.log.error(message)
    return 'failed'
  }
}
