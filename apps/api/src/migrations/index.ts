/**
 * Every data migration, in order (see runner.ts). Append only: a migration that has run anywhere is
 * never edited or removed, only followed by another.
 */
import { m0001 } from './0001-site-centric.ts'
import { m0002 } from './0002-drop-old-version-keys.ts'
import type { Migration } from './runner.ts'

export const MIGRATIONS: readonly Migration[] = [m0001, m0002]

export { scanAll, type Verification, verifySiteCentric } from './0001-site-centric.ts'
export {
  type Migration,
  type MigrationReport,
  migrationState,
  type RunOptions,
  type RunReport,
  runMigrations,
} from './runner.ts'
