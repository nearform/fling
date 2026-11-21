/**
 * drizzle-kit's view of the Node platform's Postgres schema: `pnpm --filter @fling/platform-node
 * db:generate` writes a migration into drizzle/ for each change to src/table/items.ts. The
 * migrations name no schema; src/table/database.ts applies them into the instance's own.
 */
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/table/items.ts',
  out: './drizzle',
})
