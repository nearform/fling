/**
 * Every data migration, in order (see runner.ts). Append only: a migration that has run anywhere is
 * never edited or removed, only followed by another.
 */
import type { Migration } from './runner.ts'

export const MIGRATIONS: readonly Migration[] = []

export {
  type Migration,
  type MigrationReport,
  migrationState,
  type RunOptions,
  type RunReport,
  runMigrations,
} from './runner.ts'
