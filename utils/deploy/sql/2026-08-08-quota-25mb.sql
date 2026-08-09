-- Lower the storage quota to 25 MB for the beta, and reconcile used_bytes.
--
-- 250 MB was never reachable. Only imported files count against the quota — a
-- ride built in the builder writes nothing to disk — and an imported riding day
-- costs roughly 0.3 to 1 MB, because one import is stored three times over: the
-- original upload byte-for-byte, plus a generated KML and a generated GPX. The
-- old cap was somewhere north of 250 imported days, which is not a limit, it is
-- a decoration.
--
-- 25 MB is roughly 25 to 80 imported riding days, and it clears the two floors
-- that matter. Below the 16 MB per-request body limit in routes/maps.ts, a single
-- legitimate upload could be refused by a quota it fits inside. Below about
-- 24 MB, the worst case of the 200,000-point ride cap, one maximal ride would
-- not fit at all. Either failure is impossible for a rider to diagnose.
--
-- WHY THIS FILE EXISTS RATHER THAN JUST A PUSH. quota_bytes already exists, so
-- drizzle-kit push emits ALTER COLUMN SET DEFAULT, and Postgres applies a changed
-- default to new inserts only — every existing account would silently keep
-- 250 MB. That is the mirror image of the add-a-column hazard the schema
-- comments warn about, and it is the half that is easy to miss because push
-- reports success either way.
--
-- The used_bytes reconcile is folded in because the cache was measurably wrong
-- when this was written: one account held 374 kB of files and reported 0. It is
-- incremented on import and decremented on delete and has never had a
-- reconciler. rides.size_bytes is a generated column, computed by Postgres from
-- the byte columns, so it cannot drift and is the authority here.
--
-- Additive and idempotent: no DROP, no TRUNCATE, no type change, safe to re-run.
-- Both statements are reversible by running them again with the old number.
--
--   docker exec -i tankbag-db psql -U tankbag -d tankbag -v ON_ERROR_STOP=1 \
--     --single-transaction -f - < this-file.sql

ALTER TABLE users ALTER COLUMN quota_bytes SET DEFAULT 26214400;

-- Everyone, not just new accounts. Nobody is near any limit, so nothing breaks;
-- the point is that the owner's own account is the one most likely to stress it.
UPDATE users SET quota_bytes = 26214400;

-- Recompute from truth. COALESCE covers a rider with no rides at all, where the
-- subquery returns NULL rather than 0 and would otherwise null out the column.
UPDATE users u
SET used_bytes = (SELECT COALESCE(SUM(r.size_bytes), 0) FROM rides r WHERE r.owner_id = u.id);
