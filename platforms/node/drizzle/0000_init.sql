-- IF NOT EXISTS (edited in by hand): a database whose items table predates drizzle-kit is
-- taken as it is, the same table under the same names.
CREATE TABLE IF NOT EXISTS "items" (
	"pk" text COLLATE "C" NOT NULL,
	"sk" text COLLATE "C" NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" bigint,
	CONSTRAINT "items_pkey" PRIMARY KEY("pk","sk")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_expires_at" ON "items" USING btree ("expires_at") WHERE "items"."expires_at" IS NOT NULL;