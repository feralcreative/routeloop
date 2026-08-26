ALTER TABLE "users" ALTER COLUMN "quota_bytes" SET DEFAULT 104857600;--> statement-breakpoint
-- HAND-ADDED, and the migration is wrong without it.
--
-- ALTER COLUMN ... SET DEFAULT applies to new INSERTs only, so on its own the
-- statement above raises the allowance for riders who do not exist yet and
-- leaves every current one at 25 MB — which is every rider the change was meant
-- for. The comment on quota_bytes in src/db/schema.ts calls this out by name and
-- points at utils/deploy/sql/2026-08-08-quota-25mb.sql, which did the same job
-- the last time the number moved. That directory is closed to new SQL now
-- (AGENTS.md), so the UPDATE belongs here instead.
--
-- SCOPED TO ROWS STILL ON THE OLD DEFAULT. A quota that was set by hand — raised
-- for one rider, lowered for another — is a decision somebody made, and a blanket
-- UPDATE would silently discard it. 26214400 is the previous default exactly.
UPDATE "users" SET "quota_bytes" = 104857600, "updated_at" = now() WHERE "quota_bytes" = 26214400;
