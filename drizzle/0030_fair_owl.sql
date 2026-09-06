-- HAND-WRITTEN, REPLACING WHAT THE DIFFER EMITTED. drizzle-kit cannot tell a
-- rename from a drop-and-create, and it guessed wrong: the generated file
-- carried `DROP TABLE "days" CASCADE`, which destroys every route, point and leg
-- on every ride, plus four `ADD COLUMN ... NOT NULL` against populated tables
-- that would have failed and left the schema half-applied. AGENTS.md says to
-- read the generated SQL and rewrite it when the differ guesses wrong; this is
-- that. The accompanying snapshot IS correct and is kept as generated.
--
-- EVERY STATEMENT IS A CATALOG RENAME. No table is rewritten, no row is read or
-- written, and it is safe against a fully populated database. Postgres rewrites
-- the partial predicate on uq_route_alt_active to follow the table rename on its
-- own, so the index needs nothing but its new name.
--
-- **THIS IS NOT EXPAND/CONTRACT-SAFE AND CANNOT BE MADE SO.** From the moment it
-- commits, the OLD code is selecting from a table that no longer exists under
-- that name. A rename has no additive form: the column IS the thing moving.
-- Ziad's call, 2026-09-06 — ship it with `utils/deploy/prod.sh --no-overlap`,
-- which stops the old color before starting the new one and costs a few seconds
-- of real downtime. Do NOT deploy this with the ordinary overlapping cutover.

ALTER TABLE "days" RENAME TO "routes";--> statement-breakpoint
ALTER TABLE "day_riders" RENAME TO "route_riders";--> statement-breakpoint

ALTER TABLE "points" RENAME COLUMN "day_id" TO "route_id";--> statement-breakpoint
ALTER TABLE "route_legs" RENAME COLUMN "day_id" TO "route_id";--> statement-breakpoint
ALTER TABLE "alt_votes" RENAME COLUMN "day_uid" TO "route_uid";--> statement-breakpoint
ALTER TABLE "ride_suggestions" RENAME COLUMN "day_uid" TO "route_uid";--> statement-breakpoint
ALTER TABLE "route_riders" RENAME COLUMN "day_uid" TO "route_uid";--> statement-breakpoint

ALTER SEQUENCE "days_id_seq" RENAME TO "routes_id_seq";--> statement-breakpoint

ALTER TABLE "routes" RENAME CONSTRAINT "days_pkey" TO "routes_pkey";--> statement-breakpoint
ALTER TABLE "routes" RENAME CONSTRAINT "days_ride_id_rides_id_fk" TO "routes_ride_id_rides_id_fk";--> statement-breakpoint
ALTER TABLE "routes" RENAME CONSTRAINT "days_subgroup_id_ride_subgroups_id_fk" TO "routes_subgroup_id_ride_subgroups_id_fk";--> statement-breakpoint
ALTER TABLE "points" RENAME CONSTRAINT "points_day_id_days_id_fk" TO "points_route_id_routes_id_fk";--> statement-breakpoint
ALTER TABLE "route_legs" RENAME CONSTRAINT "route_legs_day_id_days_id_fk" TO "route_legs_route_id_routes_id_fk";--> statement-breakpoint
ALTER TABLE "alt_votes" RENAME CONSTRAINT "alt_votes_ride_id_day_uid_user_id_pk" TO "alt_votes_ride_id_route_uid_user_id_pk";--> statement-breakpoint
ALTER TABLE "route_riders" RENAME CONSTRAINT "day_riders_ride_id_day_uid_rider_id_pk" TO "route_riders_ride_id_route_uid_rider_id_pk";--> statement-breakpoint
ALTER TABLE "route_riders" RENAME CONSTRAINT "day_riders_ride_id_rides_id_fk" TO "route_riders_ride_id_rides_id_fk";--> statement-breakpoint
ALTER TABLE "route_riders" RENAME CONSTRAINT "day_riders_rider_id_users_id_fk" TO "route_riders_rider_id_users_id_fk";--> statement-breakpoint

ALTER INDEX "uq_day_ride_pos" RENAME TO "uq_route_ride_pos";--> statement-breakpoint
ALTER INDEX "uq_day_ride_uid" RENAME TO "uq_route_ride_uid";--> statement-breakpoint
ALTER INDEX "uq_day_alt_active" RENAME TO "uq_route_alt_active";--> statement-breakpoint
ALTER INDEX "uq_point_day_pos" RENAME TO "uq_point_route_pos";--> statement-breakpoint
ALTER INDEX "uq_point_day_uid" RENAME TO "uq_point_route_uid";--> statement-breakpoint
ALTER INDEX "idx_point_day" RENAME TO "idx_point_route";--> statement-breakpoint
ALTER INDEX "uq_leg_day_pos" RENAME TO "uq_leg_route_pos";--> statement-breakpoint
ALTER INDEX "idx_day_rider_ride" RENAME TO "idx_route_rider_ride";
