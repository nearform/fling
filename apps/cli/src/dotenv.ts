/**
 * Local values for site secrets: the `.env` files developers already keep beside a project, never
 * published (they are dotfiles) and never uploaded by a deploy.
 *
 * `fling dev` reads `.env` with `.env.local` overriding it, and passes on only the names the
 * folder's `fling.json` declares (`localSecrets`): the rest of the file (a local database URL,
 * DEBUG) stays out of the server, as in production. `fling secrets set --from <file> NAME…` reads
 * only the names it is given (`pickEnv`). Parsing is Node's own (`util.parseEnv`).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { CliError } from './errors.ts'

/** The env files `fling dev` reads, in order: a later one overrides an earlier one. */
export const ENV_FILES = ['.env', '.env.local'] as const

async function readEnvFile(path: string): Promise<Record<string, string> | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return parseEnv(text) as Record<string, string>
}

export interface LocalSecrets {
  /** the declared secrets found, by name */
  values: Record<string, string>
  /** which file each came from */
  from: Record<string, string>
  /** declared secrets in neither file: the local `secrets_missing` */
  missing: string[]
}

/** The declared secrets' values from the folder's `.env` and `.env.local`; nothing else of them. */
export async function localSecrets(
  dir: string,
  declared: readonly string[]
): Promise<LocalSecrets> {
  const values: Record<string, string> = {}
  const from: Record<string, string> = {}
  for (const file of ENV_FILES) {
    const env = await readEnvFile(join(dir, file))
    if (!env) continue
    for (const name of declared) {
      const value = env[name]
      if (value === undefined) continue
      values[name] = value
      from[name] = file
    }
  }
  return { values, from, missing: declared.filter(n => values[n] === undefined) }
}

/** The named keys of an env file, and only those; a name it lacks is an error naming it. */
export async function pickEnv(
  path: string,
  names: readonly string[]
): Promise<Record<string, string>> {
  const env = await readEnvFile(path)
  if (!env) throw new CliError(`No such file: ${path}`)
  const lacking = names.filter(n => env[n] === undefined)
  if (lacking.length > 0) {
    throw new CliError(`${path} has no ${lacking.join(', ')}`, {
      hint: `Add ${lacking.length === 1 ? 'it' : 'them'} to the file as NAME=value, or pass the value on stdin.`,
    })
  }
  return Object.fromEntries(names.map(n => [n, env[n] as string]))
}
