/**
 * CLI entry point. Wires commander to the thin command modules; the ONE place that maps errors to
 * exit codes (0 ok · 1 error · 2 not logged in · 3 forbidden) and prints them. Global `--server`
 * and `--json` apply to every command. Bare `fling` prints help; `fling <path>` deploys when the
 * path exists (route.ts).
 */
import chalk from 'chalk'
import { Command } from 'commander'
import { runLogin, runLogout, runWhoami } from './commands/auth.ts'
import { runComment, runComments, runResolve, runUncomment } from './commands/comments.ts'
import { runDeploy } from './commands/deploy.ts'
import { runSetup } from './commands/setup.ts'
import {
  runArchive,
  runFiles,
  runInfo,
  runList,
  runRemove,
  runRollback,
  runShare,
  runVersions,
  runVisibility,
} from './commands/sites.ts'
import { ENV } from './config.ts'
import { type CommandContext, createContext } from './context.ts'
import { CliError, exitCodeFor } from './errors.ts'
import { runMcpServer } from './mcp.ts'
import { BIN_NAME, VERSION } from './package-info.ts'
import { routeArgs, routeOptionsFor } from './route.ts'
import { brand, logo } from './ui/theme.ts'
import { createLogger } from './utils/logger.ts'
import { formatJson } from './utils/output.ts'

interface GlobalOptions {
  server?: string
  json?: boolean
}

const program = new Command()
program
  .name(BIN_NAME)
  .description('Fling a folder of static files at Fling and get a link back')
  .version(VERSION)
  .option('--server <url>', `server URL (default: $${ENV.url}, else the one you logged in to)`)
  .option('--json', 'print JSON instead of human output', false)
  .showHelpAfterError()
  .configureHelp({
    sortSubcommands: false,
    styleTitle: title => chalk.bold(brand.primary(title)),
    styleCommandText: text => chalk.bold(text),
    styleSubcommandText: text => brand.accent(text),
    styleOptionText: text => brand.accent(text),
    styleArgumentText: text => chalk.dim(text),
  })
  .addHelpText('before', () =>
    process.stdout.isTTY ? logo({ columns: process.stdout.columns }) : ''
  )
  .addHelpText(
    'after',
    () => `
${chalk.bold(brand.primary('Examples:'))}
  $ ${BIN_NAME} login https://fling.example.com  sign in to your Fling (once; there is no default)
  $ ${BIN_NAME} setup                      sign in and add Fling to Claude Code / Claude Desktop
  $ ${BIN_NAME} deploy ./dist --name my-app → https://my-app.<your sites domain>
  $ ${BIN_NAME} ./dist                     the same: an existing path deploys
  $ ${BIN_NAME} ./dist --yes               no prompts (CI): use the generated name, fail if it is taken
  $ ${BIN_NAME} "Pitch Deck.html"          a single page
  $ ${BIN_NAME} site.zip                   a zip of a site
  $ ${BIN_NAME} share my-app               public link for people who can't sign in

${chalk.dim(`Exit codes: 0 ok · 1 error · 2 not logged in · 3 forbidden
Env:        ${ENV.apiKey} · ${ENV.url} · ${ENV.configDir} · ${ENV.debug}`)}`
  )

/** Run a command with a context built from the global options; print + exit-code any error. */
function action<A extends unknown[]>(handler: (ctx: CommandContext, ...args: A) => Promise<void>) {
  return async (...args: unknown[]) => {
    const command = args.at(-1) as Command
    const globals = command.optsWithGlobals<GlobalOptions>()
    let ctx: CommandContext | undefined
    try {
      ctx = await createContext({ server: globals.server, json: globals.json })
      await handler(ctx, ...(args.slice(0, -1) as A))
    } catch (error) {
      report(error, ctx)
      process.exitCode = exitCodeFor(error)
    }
  }
}

function report(error: unknown, ctx: CommandContext | undefined): void {
  const log = ctx?.log ?? createLogger()
  const message = error instanceof Error ? error.message : String(error)
  log.error(message)
  if (error instanceof CliError && error.hint) log.hint(error.hint)
  if (ctx?.config.debug && error instanceof Error && error.stack) log.hint(error.stack)
  if (ctx?.json) {
    const { code, findings, paths } = error as {
      code?: unknown
      findings?: unknown
      paths?: unknown
    }
    process.stdout.write(
      `${formatJson({
        error: {
          message,
          exitCode: exitCodeFor(error),
          ...(typeof code === 'string' ? { code } : {}),
          ...(Array.isArray(findings) ? { findings } : {}),
          ...(Array.isArray(paths) ? { paths } : {}),
        },
      })}\n`
    )
  }
}

// ---- deploy --------------------------------------------------------------------------------

program
  .command('deploy [path]')
  .helpGroup('Deploy:')
  .description(
    'deploy a folder (default: .), a single .html file, a .zip or any file. `fling <path>` is short for it'
  )
  .option(
    '-n, --name <name>',
    'site name — names are global, first come first served (default: generated from the project and folder, e.g. rocketpod-docs; you confirm it on a terminal)'
  )
  .option('--spa', 'single-page app: serve index.html for unknown paths')
  .option('--public', 'make the site public (default: sign-in required)')
  .option(
    '-y, --yes',
    'never prompt: accept the generated name; without index.html, list the HTML pages (or fling anyway if there are none)'
  )
  .option('--list-html', 'no index.html at the root: generate one listing the HTML pages')
  .option('--no-list-html', 'no index.html at the root: fling anyway (the root will 404)')
  .action(
    action(
      (
        ctx,
        path: string | undefined,
        opts: { name?: string; spa?: boolean; public?: boolean; yes?: boolean; listHtml?: boolean }
      ) => runDeploy(ctx, path, opts)
    )
  )

// ---- setup and auth ------------------------------------------------------------------------

program
  .command('setup [url]')
  .helpGroup('Setup:')
  .description(
    'sign in (to the Fling at url, the first time), then add the Fling plugin to Claude Code and the extension to Claude Desktop'
  )
  .option('-y, --yes', 'do every step without asking')
  .option('-s, --scope <scope>', 'Claude Code plugin scope: user, project or local', 'user')
  .action(
    action((ctx, url: string | undefined, opts: { yes?: boolean; scope?: string }) =>
      runSetup(ctx, { ...opts, url })
    )
  )
program
  .command('login [url]')
  .helpGroup('Setup:')
  .description(
    'sign in through the browser to the Fling at url (remembered; later logins can omit it) and store an API key'
  )
  .action(
    action(async (ctx, url: string | undefined) => {
      await runLogin(ctx, url)
      ctx.log.hint(`Next: \`${BIN_NAME} setup\` adds Fling to Claude Code and Claude Desktop.`)
    })
  )
program
  .command('logout')
  .helpGroup('Setup:')
  .description('remove the stored API key')
  .action(action(ctx => runLogout(ctx)))
program
  .command('whoami')
  .helpGroup('Setup:')
  .description('show the signed-in user')
  .action(action(ctx => runWhoami(ctx)))
// `help` sits with the setup commands instead of under its own "Commands:" heading.
program.commandsGroup('Setup:').helpCommand('help [command]', 'show help for a command')

// ---- sites ---------------------------------------------------------------------------------

program
  .command('ls')
  .helpGroup('Sites:')
  .alias('list')
  .description('list your sites')
  .option('--archived', 'list archived sites')
  .action(action((ctx, opts: { archived?: boolean }) => runList(ctx, opts)))
program
  .command('info <name>')
  .helpGroup('Sites:')
  .description('show a site')
  .action(action((ctx, name: string) => runInfo(ctx, name)))
program
  .command('versions <name>')
  .helpGroup('Sites:')
  .description("list a site's versions (* = live)")
  .action(action((ctx, name: string) => runVersions(ctx, name)))
program
  .command('files <name> [versionId]')
  .helpGroup('Sites:')
  .description("list the files in a site's live version (or in versionId)")
  .action(
    action((ctx, name: string, versionId: string | undefined) => runFiles(ctx, name, versionId))
  )
program
  .command('rollback <name> <versionId>')
  .helpGroup('Sites:')
  .description('serve an earlier version again')
  .action(action((ctx, name: string, versionId: string) => runRollback(ctx, name, versionId)))
program
  .command('share <name>')
  .helpGroup('Sites:')
  .description('print (or create) a public share link — anyone with it can view the site')
  .option('--refresh', 'replace the link; the old one stops working')
  .option('--revoke', 'remove the link')
  .action(
    action((ctx, name: string, opts: { refresh?: boolean; revoke?: boolean }) =>
      runShare(ctx, name, opts)
    )
  )
program
  .command('visibility <name> <visibility>')
  .helpGroup('Sites:')
  .description('private (sign-in required) or public (anyone)')
  .action(action((ctx, name: string, visibility: string) => runVisibility(ctx, name, visibility)))
program
  .command('archive <name>')
  .helpGroup('Sites:')
  .description('take a site offline (404) but keep its files; undo with unarchive')
  .action(action((ctx, name: string) => runArchive(ctx, name)))
program
  .command('unarchive <name>')
  .helpGroup('Sites:')
  .description('bring an archived site back')
  .action(action((ctx, name: string) => runArchive(ctx, name, true)))
program
  .command('rm <name>')
  .helpGroup('Sites:')
  .alias('delete')
  .description('delete a site and all its versions (asks first unless --yes)')
  .option('-y, --yes', 'do not ask for confirmation')
  .action(action((ctx, name: string, opts: { yes?: boolean }) => runRemove(ctx, name, opts)))

// ---- comments ------------------------------------------------------------------------------

program
  .command('comments <name>')
  .helpGroup('Comments:')
  .description("list a site's open comment threads (people leave them on its review page)")
  .option('-p, --path <path>', 'only this page, e.g. / or /docs/')
  .option('-a, --all', 'include resolved threads')
  .action(
    action((ctx, name: string, opts: { path?: string; all?: boolean }) =>
      runComments(ctx, name, opts)
    )
  )
program
  .command('comment <name> <text>')
  .helpGroup('Comments:')
  .description('comment on a page of a site (default: its home page), or reply to a thread')
  .option('-p, --path <path>', 'the page, e.g. /docs/ or about.html')
  .option('-r, --reply <id>', 'reply to this thread')
  .action(
    action((ctx, name: string, text: string, opts: { path?: string; reply?: string }) =>
      runComment(ctx, name, text, opts)
    )
  )
program
  .command('resolve <name> <id>')
  .helpGroup('Comments:')
  .description('mark a comment thread resolved')
  .option('--reopen', 'reopen it instead')
  .action(
    action((ctx, name: string, id: string, opts: { reopen?: boolean }) =>
      runResolve(ctx, name, id, opts)
    )
  )
program
  .command('uncomment <name> <id>')
  .helpGroup('Comments:')
  .alias('delete-comment')
  .description('delete a comment (a thread goes with its replies; asks first unless --yes)')
  .option('-y, --yes', 'do not ask for confirmation')
  .action(
    action((ctx, name: string, id: string, opts: { yes?: boolean }) =>
      runUncomment(ctx, name, id, opts)
    )
  )

// ---- agents --------------------------------------------------------------------------------

program
  .command('mcp')
  .helpGroup('Agents:')
  .description('run the MCP server on stdio (used by the Claude Code plugin)')
  .action(async (_opts: unknown, command: Command) => {
    const globals = command.optsWithGlobals<GlobalOptions>()
    await runMcpServer({ server: globals.server })
  })

async function main(): Promise<void> {
  const route = await routeArgs(process.argv.slice(2), routeOptionsFor(program))
  if (route.kind === 'help') {
    program.outputHelp()
    return
  }
  if (route.kind === 'unknown') {
    const log = createLogger()
    log.error(`"${route.arg}" is not a command, file or folder`)
    log.hint(
      `Run \`${BIN_NAME} --help\` for the commands, or \`${BIN_NAME} deploy <path>\` to deploy.`
    )
    process.exitCode = 1
    return
  }
  await program.parseAsync(route.args, { from: 'user' })
}

await main()
