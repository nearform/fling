/**
 * After a deploy goes live or a share link is created, wait until the edge routes the URL (the
 * shared `waitUntilReachable`), so the link we print doesn't 404 for the first few seconds.
 * `FLING_NO_WAIT=1` (and test runs) skip it.
 */
import {
  NOT_READY_NOTE,
  probeUrl,
  type ReachableResult,
  readinessWaitDisabled,
  waitUntilReachable,
} from '@fling/shared'
import chalk from 'chalk'
import type { FetchLike } from './api.ts'
import type { Env } from './config.ts'

export interface ReadyResult extends ReachableResult {
  /** the wait was skipped (FLING_NO_WAIT / tests): `ready` is assumed */
  skipped?: boolean
}

/** Poll `url` (a site or share URL) whose served version has `paths`. */
export type ReadyWaiter = (
  url: string,
  paths: readonly string[],
  opts?: { onWaiting?: () => void }
) => Promise<ReadyResult>

export const skipWait: ReadyWaiter = async () => ({ ready: true, waitedMs: 0, skipped: true })

export function createReadyWaiter(
  options: { env?: Env; fetch?: FetchLike; timeoutMs?: number } = {}
): ReadyWaiter {
  if (readinessWaitDisabled(options.env ?? process.env)) return skipWait
  return (url, paths, opts) =>
    waitUntilReachable(probeUrl(url, paths), {
      timeoutMs: options.timeoutMs,
      fetch: options.fetch,
      onWaiting: opts?.onWaiting,
    })
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * Wait with a spinner line ("Waiting for the edge…") on a terminal; on timeout, warn with the
 * URL and the "reload if you see a 404" note. Never throws.
 */
export async function waitWithSpinner(
  waiter: ReadyWaiter | undefined,
  url: string,
  paths: readonly string[],
  io: { progress: (line: string | null) => void; warn: (message: string) => void }
): Promise<ReadyResult> {
  if (!waiter) return { ready: true, waitedMs: 0, skipped: true }
  let frame = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const draw = () =>
    io.progress(`${chalk.cyan(SPINNER[frame++ % SPINNER.length])} Waiting for the edge…`)
  try {
    const result = await waiter(url, paths, {
      onWaiting: () => {
        draw()
        timer = setInterval(draw, 100)
        timer.unref?.()
      },
    }).catch(() => ({ ready: false, waitedMs: 0 }))
    if (timer) io.progress(null)
    if (!result.ready) io.warn(`${url} — ${NOT_READY_NOTE}`)
    return result
  } finally {
    if (timer) clearInterval(timer)
  }
}
