/**
 * What a bare `fling …` means, decided before commander parses it:
 *
 *   fling                 → help
 *   fling ./dist …        → `fling deploy ./dist …` when the first argument exists on disk
 *   fling ls …            → the command
 *   fling nonsense        → "unknown command or path" + help
 *
 * A path wins over a command of the same name (a folder called `ls` deploys); `fling deploy ls`
 * is always explicit. `-h`/`--help`/`-V`/`--version` pass straight through.
 */
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Command } from 'commander'

export type Route =
  | { kind: 'help' }
  | { kind: 'run'; args: string[] }
  | { kind: 'unknown'; arg: string }

export interface RouteOptions {
  /** Command names and aliases (plus `help`). */
  commands: ReadonlySet<string>
  /** Flags (`-n`, `--name`…) that take a value, so it isn't mistaken for the first argument. */
  valueFlags: ReadonlySet<string>
  exists?: (path: string) => Promise<boolean>
}

const PASS_THROUGH = new Set(['-h', '--help', '-V', '--version'])

const pathExists = (path: string) =>
  stat(resolve(path)).then(
    () => true,
    () => false
  )

export async function routeArgs(args: readonly string[], opts: RouteOptions): Promise<Route> {
  const exists = opts.exists ?? pathExists
  let first: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') {
      first = args[i + 1]
      break
    }
    if (arg.startsWith('-')) {
      if (PASS_THROUGH.has(arg)) return { kind: 'run', args: [...args] }
      if (opts.valueFlags.has(arg)) i++
      continue
    }
    first = arg
    break
  }
  if (first === undefined) return { kind: 'help' }
  if (await exists(first)) return { kind: 'run', args: ['deploy', ...args] }
  if (opts.commands.has(first)) return { kind: 'run', args: [...args] }
  return { kind: 'unknown', arg: first }
}

/** The names, aliases and value-taking flags of `program` and its commands, for `routeArgs`. */
export function routeOptionsFor(program: Command): RouteOptions {
  const commands = new Set(['help'])
  const valueFlags = new Set<string>()
  const addFlags = (command: Command) => {
    for (const option of command.options)
      if (option.required || option.optional)
        for (const flag of [option.short, option.long]) if (flag) valueFlags.add(flag)
  }
  addFlags(program)
  for (const command of program.commands) {
    commands.add(command.name())
    for (const alias of command.aliases()) commands.add(alias)
    addFlags(command)
  }
  return { commands, valueFlags }
}
