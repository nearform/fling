-- The schema D1Table (src/table/d1.ts) reads and writes: applied by `wrangler d1 migrations apply`.
-- These are D1 schema migrations; Fling's data migrations (apps/api/src/migrations) run on top.

-- Every item: `data` is the item's JSON without pk and sk; `expires_at` is its expiresAt in epoch
-- ms (NULL: never), kept in a column so reads can filter dead items and the purge can find them.
-- pk and sk compare with BINARY collation, i.e. memcmp of their UTF-8 bytes: the byte order the
-- Table port promises.
CREATE TABLE items (
  pk TEXT NOT NULL COLLATE BINARY,
  sk TEXT NOT NULL COLLATE BINARY,
  data TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (pk, sk)
) WITHOUT ROWID;

CREATE INDEX items_expires_at ON items (expires_at) WHERE expires_at IS NOT NULL;

-- Write conditions: `INSERT INTO conditions (ok) SELECT <condition>` aborts the statement, and
-- with it the whole D1 batch (a transaction), when the condition is false. Nothing is ever stored.
CREATE TABLE conditions (ok INTEGER NOT NULL);

CREATE TRIGGER conditions_check BEFORE INSERT ON conditions
BEGIN
  SELECT RAISE(ABORT, 'fling: condition failed') WHERE NEW.ok = 0;
  SELECT RAISE(IGNORE);
END;
