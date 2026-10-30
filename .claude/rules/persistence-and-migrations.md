---
paths:
  - apps/api/src/store/**
  - apps/api/src/table/**
  - apps/api/src/migrations/**
  - apps/api/src/route-table/**
  - platforms/*/src/**
  - platforms/cloudflare/migrations/**
  - platforms/cloudflare/scripts/migrate.ts
  - platforms/aws/scripts/migrate-rehearse.ts
  - packages/conformance/**
---

# Persistence and data migrations

## The Table port (`apps/api/src/table/types.ts`)

- The operations are get, query by partition with an sk prefix (in sk byte order), put, update,
  delete, and transact (at most 25 operations, all or nothing). Conditions are `ifAbsent`,
  `ifExists` and `fieldEquals`. A failed condition throws `ConditionFailed`. An item with an
  `expiresAt` in the past counts as absent.
- `scan` is for migrations only. Every request path is answered by key or by prefix query. When a
  new access pattern needs a list, add an index item; don't scan or add a secondary index.
- Keep the port small, because every cloud must implement it with the same semantics. A new
  operation or condition needs the conformance suite extended (`packages/conformance/src/table.ts`)
  and every adapter updated: memory, DynamoDB, D1.
- D1 stores the generic `items` table (`platforms/cloudflare/migrations/0001_init.sql`). New record
  kinds need no SQL migration. A schema change does: a new numbered `.sql` file, additive only.

## Records (`apps/api/src/store/`)

- All domain persistence goes through `Records`, behind the `Store` interface. Routes never touch
  `Table` directly.
- Keys are site-centric. The site partition is `SITE#<id>` (`SITE`, `VERSION#…`, `COMMENT#…`).
  Lookups use index items: `USER#<email>/SITE#<name>` (the creator's), `USER#<email>/ROLE#<siteId>`
  and `GROUP#<id>/ROLE#<siteId>` (role items), `NAME#<name>/NAME`, `USERS/USER#<email>`.
  The audit log is `AUDIT/<sortable id>`. Writes that span items (a claim and its site, a record and
  its index) go in one `transact`.
- Every record has `v`, the version of its shape. Bump `v` when a shape changes. Reads upgrade older
  shapes and tolerate one version ahead (`store/evolution.ts`), so a rollback by one release keeps
  working.

## Data migrations (`apps/api/src/migrations/`)

- To add one, create a file `NNNN-<what>.ts` and append it to `MIGRATIONS` in `index.ts`.
  Migrations are append-only: once one has run anywhere, never edit or delete it.
- Each migration must be idempotent, resumable, and safe while the API serves traffic: conditional
  writes, never a blind overwrite. It spells out its keys and shapes in its own file and never
  imports from Records.
- Expand, then contract. The release that ships a migration must serve correctly before the
  migration runs, and must survive a rollback to the release before it. Deploys run migrations
  after the new code is live (AWS through a Lambda invoke, Cloudflare from the deploy job). A step
  that deletes or rewrites in place is `auto: false` and runs by hand later.
- Start the header with the migration's id and EXPAND or CONTRACT, then a table of what it reads and
  what it writes, then its safety and rollback story (see `0003-users-index.ts`).
- Before a migration first runs in production, rehearse it on a point-in-time copy of the table
  (`platforms/aws/DEPLOY.md`, Rehearsing a data migration). The rehearsal itself is a live action.
