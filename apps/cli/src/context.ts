/**
 * Per-invocation command context: resolved config, logger (stderr), output (stdout) and the
 * injectable seams tests use (`fetch`, `open`, `confirm`, TTY). Commands receive a context and
 * return; they never touch `process` directly.
 */
import { confirm, isCancel, text } from '@clack/prompts'
import { type ApiClient, createApiClient, type FetchLike } from './api.ts'
import { type ConfigStore, createConfigStore, type Env, type ResolvedConfig } from './config.ts'
import { CliError, NoServerError, NotLoggedInError } from './errors.ts'
import { BIN_NAME } from './package-info.ts'
import { createReadyWaiter, type ReadyWaiter } from './ready.ts'
import { createLogger, type Logger } from './utils/logger.ts'
import { createOutput, type Output } from './utils/output.ts'

export type OpenLike = (url: string) => Promise<unknown>
export type ConfirmLike = (question: string) => Promise<boolean>
/** Ask a free-text question on the terminal; resolves to the raw answer (untrimmed). */
export type PromptLike = (question: string) => Promise<string>

export interface CommandContext {
  store: ConfigStore
  /** Config merged with env and `--server` — what the command should use. */
  config: ResolvedConfig
  json: boolean
  log: Logger
  out: Output
  fetch: FetchLike
  open: OpenLike
  /** Whether stdin/stderr are an interactive terminal (prompts, progress line). */
  interactive: boolean
  confirm: ConfirmLike
  prompt: PromptLike
  /** Rewrites a single status line on stderr (TTY only); `null` clears it. */
  progress: (line: string | null) => void
  binName: string
  /** Waits for a new site / share link to reach the edge; absent → no wait (tests). */
  waitReady?: ReadyWaiter
}

export interface ContextOptions {
  /** `--server <url>` */
  server?: string
  json?: boolean
  store?: ConfigStore
  env?: Env
  log?: Logger
  out?: Output
  fetch?: FetchLike
  open?: OpenLike
}

export async function createContext(options: ContextOptions = {}): Promise<CommandContext> {
  const store = options.store ?? createConfigStore({ env: options.env })
  const json = options.json ?? false
  const config = await store.resolve({ serverUrl: options.server })
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY)
  return {
    store,
    config,
    json,
    log: options.log ?? createLogger({ debug: config.debug }),
    out: options.out ?? createOutput({ json }),
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    open: options.open ?? (async url => (await import('open')).default(url)),
    interactive,
    confirm: ttyConfirm,
    prompt: ttyPrompt,
    progress: interactive ? ttyProgress : () => {},
    binName: BIN_NAME,
    waitReady: createReadyWaiter({ env: options.env }),
  }
}

// Prompts draw on stderr so stdout stays clean for pipes and --json. Ctrl-C / Esc cancels.
async function ttyConfirm(question: string): Promise<boolean> {
  const answer = await confirm({ message: question, initialValue: false, output: process.stderr })
  if (isCancel(answer)) throw new CliError('Cancelled')
  return answer
}

async function ttyPrompt(question: string): Promise<string> {
  const answer = await text({ message: question.trim(), output: process.stderr })
  if (isCancel(answer)) throw new CliError('Cancelled')
  return answer ?? ''
}

function ttyProgress(line: string | null): void {
  process.stderr.write(`\r\x1b[2K${line ?? ''}`)
}

/** The server to talk to, or `NoServerError` (exit 2): there is no default server. */
export function requireServer(ctx: Pick<CommandContext, 'config' | 'binName'>): string {
  if (!ctx.config.serverUrl) throw new NoServerError(ctx.binName)
  return ctx.config.serverUrl
}

/** An authenticated client, or `NoServerError` / `NotLoggedInError` (exit 2). */
export function requireClient(
  ctx: Pick<CommandContext, 'config' | 'fetch' | 'binName'>
): ApiClient {
  const serverUrl = requireServer(ctx)
  if (!ctx.config.apiKey) throw new NotLoggedInError(ctx.binName)
  return createApiClient({
    serverUrl,
    apiKey: ctx.config.apiKey,
    fetch: ctx.fetch,
  })
}
