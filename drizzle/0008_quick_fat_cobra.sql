--
-- Every point in a day carries a position now, not just the stops.
--
-- Hand-written per the rule in AGENTS.md. drizzle-kit generated exactly two
-- statements — DROP CONSTRAINT then `ALTER COLUMN "position" SET NOT NULL` —
-- and the second fails outright on any populated table, because every POI ever
-- written carries null. There is no backfill in the generated version and no
-- warning that one is needed.
--
-- The unique index is dropped first and recreated last. It is not strictly
-- required for the backfill below (POIs move from NULL to values at or above
-- the day's stop count, which no stop occupies, so no intermediate state
-- collides) — but the backfill deliberately renumbers BOTH kinds rather than
-- trusting stop positions to be dense, and a renumber that moves a stop could
-- transiently collide with another stop. A unique index is checked per row and
-- cannot be deferred, so the only way to make the renumber safe in general is
-- to not have it there while it runs.
--
DROP INDEX "uq_point_day_pos";--> statement-breakpoint
--
-- The backfill. One pass, both kinds, dense from 0 per day:
--
--   * stops first, keeping the order they already had
--   * then POIs, in along-the-route order — which is the order the builder has
--     always DISPLAYED them in, so nothing a rider is looking at moves
--
-- `dist_from_start_m` is null on a trackless import and on any POI that was
-- never projected; those sort last and fall back to `id`, which is insertion
-- order and the only other thing that means anything here.
--
-- Re-running is stable: stops sort before POIs on the first key regardless, and
-- once a POI has a position it keeps the same relative order it was given.
--
WITH ordered AS (
	SELECT
		id,
		row_number() OVER (
			PARTITION BY day_id
			ORDER BY
				(kind <> 'stop'),
				"position" NULLS LAST,
				dist_from_start_m NULLS LAST,
				id
		) - 1 AS newpos
	FROM "points"
)
UPDATE "points" p SET "position" = o.newpos FROM ordered o WHERE p.id = o.id;--> statement-breakpoint
--
-- Says what ck_point_stop_pos used to say, and more: it said a STOP must be
-- ordered, and this says every point is.
--
ALTER TABLE "points" DROP CONSTRAINT "ck_point_stop_pos";--> statement-breakpoint
ALTER TABLE "points" ALTER COLUMN "position" SET NOT NULL;--> statement-breakpoint
--
-- Back, and now a real constraint rather than one leaning on NULLS DISTINCT to
-- let every POI in a day share a null.
--
CREATE UNIQUE INDEX "uq_point_day_pos" ON "points" USING btree ("day_id","position");
