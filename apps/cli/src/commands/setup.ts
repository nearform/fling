/**
 * `fling setup [url] [--yes] [--scope user|project|local]` — get a machine ready in one go:
 *
 *   1. Sign in, to the Fling at `url` (needed the first time: there is no default server); skipped
 *      when the stored key for that server still works.
 *   2. Claude Code: install the Fling plugin (skill + MCP server) through the `claude` CLI, or
 *      update it when it is already installed. Skipped, with a hint, when `claude` is missing.
 *   3. Claude Desktop (macOS / Windows, when it is installed): download fling.mcpb and open it;
 *      Desktop then asks the user to confirm the install.
 *
 * On a terminal it asks before steps 2 and 3; with `--yes` or without a terminal it does them all.
 * Steps report and carry on: one failing doesn't stop the others; the exit code is 1 if any did.
 */
import { intro, outro, spinner } from '@clack/prompts'
import chalk from 'chalk'
import {
  claudeCodeStatus,
  downloadExtension,
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
import { normalizeServerUrl } from '../config.ts'
import { type CommandContext, requireClient, requireServer } from '../context.ts'
import { CliError, exitCodeFor } from '../errors.ts'
import { whoami } from '../sites.ts'
import { logo } from '../ui/theme.ts'
import { createLogger } from '../utils/logger.ts'
import { runLogin } from './auth.ts'

export interface SetupOptions {
  yes?: boolean
  scope?: string
  /** The Fling to sign in to; default: the one logged in to before. */
  url?: string
}

export interface SetupDeps {
  runClaude?: RunClaude
  findClaudeDesktop?: () => Promise<string | null>
  downloadExtension?: (serverUrl: string) => Promise<string>
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

  const results: Record<'login' | 'claudeCode' | 'claudeDesktop', StepResult> = {
    login: await stepLogin(ctx, opts.url),
    claudeCode: 'skipped',
    claudeDesktop: 'skipped',
  }
  // A login stores the server (and may have changed it): read the config again.
  const after: CommandContext =
    results.login === 'done' ? { ...ctx, config: await ctx.store.resolve() } : ctx
  results.claudeCode = await stepClaudeCode(after, run, scope, ask, fancy)
  results.claudeDesktop = await stepClaudeDesktop(after, deps, ask, fancy)

  const failed = Object.values(results).includes('failed')
  if (fancy)
    outro(
      failed
        ? chalk.yellow('Setup finished with problems — see above, then run `fling setup` again.')
        : `You're set. Try ${chalk.bold(`${ctx.binName} deploy ./dist`)}, or ask Claude to “fling this”.`,
      { output: process.stderr }
    )
  ctx.out.data(results, () => '')
  if (failed) process.exitCode = 1
}

async function stepLogin(ctx: CommandContext, url: string | undefined): Promise<StepResult> {
  // A different server than the stored one: always sign in to it.
  const sameServer = url === undefined || safeNormalize(url) === ctx.config.serverUrl
  if (ctx.config.apiKey && sameServer) {
    try {
      const me = await whoami(requireClient(ctx))
      ctx.log.success(`Signed in as ${chalk.bold(me.name)} ${chalk.dim(`<${me.email}>`)}`)
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
    await runLogin({ ...ctx, json: false }, url)
    return 'done'
  } catch (error) {
    ctx.log.error(error instanceof Error ? error.message : String(error))
    return 'failed'
  }
}

function safeNormalize(url: string): string | undefined {
  try {
    return normalizeServerUrl(url)
  } catch {
    return undefined
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

  const installed = 'installed' in status && status.installed
  const question = installed
    ? `The Fling plugin is installed in Claude Code${status.version ? ` (${status.version})` : ''}. Update it to the latest?`
    : 'Install the Fling plugin (skill + MCP server) into Claude Code?'
  if (ask && !(await ctx.confirm(question))) {
    ctx.log.info(chalk.dim('Claude Code plugin: skipped'))
    return installed ? 'already' : 'skipped'
  }

  const s = fancy ? spinner({ output: process.stderr }) : null
  s?.start(installed ? 'Updating the Claude Code plugin' : 'Installing the Claude Code plugin')
  try {
    if (installed) await updatePlugin(run, status.scope)
    else await installPlugin(run, scope)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (s) s.error(message)
    else ctx.log.error(message)
    return 'failed'
  }
  const done = installed
    ? `Claude Code plugin ${PLUGIN_NAME} is up to date`
    : `Claude Code plugin ${PLUGIN_NAME} installed ${chalk.dim(`(${scope} scope)`)}`
  if (s) s.stop(done)
  else ctx.log.success(done)
  ctx.log.hint('Restart Claude Code (or run /reload-plugins) to pick it up.')
  return installed ? 'updated' : 'done'
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
  try {
    const file = await (
      deps.downloadExtension ?? (serverUrl => downloadExtension(serverUrl, ctx.fetch))
    )(requireServer(ctx))
    await ctx.open(file)
    const done = 'Opened fling.mcpb in Claude Desktop — click Install there to finish'
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
