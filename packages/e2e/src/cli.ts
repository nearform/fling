/**
 * Run the real CLI (apps/cli, from source) the way a person or a CI job does: `--json`, the server
 * and API key from FLING_URL / FLING_API_KEY, its own config dir. The readiness wait stays on, so a
 * deploy only returns once the edge routes the site (or says it gave up).
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const TSX = join(REPO, 'node_modules', '.bin', 'tsx')
const CLI = join(REPO, 'apps', 'cli', 'src', 'cli.ts')

export interface CliOptions {
  serverUrl: string
  apiKey: string
  configDir: string
}

export function runCli(args: string[], opts: CliOptions): Promise<unknown> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    FLING_URL: opts.serverUrl,
    FLING_API_KEY: opts.apiKey,
    FLING_CONFIG_DIR: opts.configDir,
    NO_COLOR: '1',
  }
  // Test runners turn the readiness wait off; the scenario needs it on.
  for (const k of ['VITEST', 'NODE_ENV', 'FLING_NO_WAIT']) delete env[k]
  return new Promise((resolve, reject) => {
    execFile(
      TSX,
      [CLI, '--json', ...args],
      { cwd: REPO, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `fling ${args.join(' ')} failed: ${stderr.trim() || stdout.trim() || err.message}`
            )
          )
          return
        }
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : null)
        } catch {
          reject(new Error(`fling ${args.join(' ')}: not JSON: ${stdout.slice(0, 300)}`))
        }
      }
    )
  })
}
