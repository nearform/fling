/**
 * `fling doctor` — check this machine's Fling setup (doctor.ts) and print one line per check:
 * ✔ ok, ▲ warning, ✖ problem, each warning and problem with its fix. Under `--json` the checks
 * are the data. Exit code 1 when any check is a problem. It changes nothing.
 */
import chalk from 'chalk'
import { findClaudeDesktop, runClaude } from '../claude.ts'
import type { CommandContext } from '../context.ts'
import {
  type Check,
  type CheckArea,
  type DoctorDeps,
  doctorExitCode,
  runChecks,
  systemDoctorDeps,
} from '../doctor.ts'
import { symbols } from '../ui/theme.ts'

const AREAS: Record<CheckArea, string> = {
  cli: 'CLI',
  config: 'Config',
  server: 'Flings',
  claudeCode: 'Claude Code',
  claudeDesktop: 'Claude Desktop',
}

const SYMBOLS = { ok: symbols.success, warning: symbols.warn, problem: symbols.error }

export async function runDoctor(ctx: CommandContext, deps?: Partial<DoctorDeps>): Promise<void> {
  const checks = await runChecks({
    ...systemDoctorDeps(ctx.store, ctx.fetch, runClaude, () => findClaudeDesktop()),
    ...deps,
  })
  const ok = doctorExitCode(checks) === 0
  ctx.out.data({ ok, checks }, () => render(checks))
  if (!ok) process.exitCode = 1
}

function render(checks: readonly Check[]): string {
  const lines: string[] = []
  let area: CheckArea | undefined
  for (const c of checks) {
    if (c.area !== area) {
      area = c.area
      lines.push(`${lines.length ? '\n' : ''}${chalk.bold(AREAS[c.area])}`)
    }
    const message = c.status === 'problem' ? chalk.red(c.message) : c.message
    lines.push(`${SYMBOLS[c.status]} ${message}${c.fix ? chalk.dim(` — fix: ${c.fix}`) : ''}`)
  }
  return lines.join('\n')
}
