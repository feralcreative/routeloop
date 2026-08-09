-- routes -> days, and the two columns that referenced it.
--
-- Settled 2026-08-09: the hierarchy is ride > day > leg > stop/POI. The table
-- was called `routes` while every rider-facing surface said "day" — the builder
-- slider, the viewer legend, DAY_COLORS, the `d02` filename field — and "route"
-- was simultaneously doing duty as the import copy's word for a whole ride and
-- as the ~130 `adminRoutes`/`app.route()` identifiers that mean HTTP handlers.
--
-- `route_legs` deliberately keeps its name: the "route" in it is the path a day
-- traces, which is what those legs compose, not a reference to this table. Only
-- its foreign key moved.
--
-- Every statement here is a catalog rename — no table rewrite, no data copied,
-- no rows touched. Safe to run against a populated database, and the whole file
-- is one transaction, so a wrong name aborts it rather than half-applying.
--
-- Apply with:
--   docker compose exec -T db psql -U tankbag -d tankbag \
--     < utils/deploy/sql/2026-08-09-routes-to-days.sql

BEGIN;

-- The table itself, plus the objects Postgres names after it. Renaming a table
-- does NOT rename its owned sequence or its primary-key index, so both are
-- spelled out; leaving them would keep `routes` alive in the catalog and make
-- `drizzle-kit push` report drift on a schema that is actually correct.
ALTER TABLE routes RENAME TO days;
ALTER SEQUENCE routes_id_seq RENAME TO days_id_seq;
ALTER INDEX routes_pkey RENAME TO days_pkey;
ALTER INDEX uq_route_ride_pos RENAME TO uq_day_ride_pos;
ALTER TABLE days RENAME CONSTRAINT routes_ride_id_rides_id_fk TO days_ride_id_rides_id_fk;

-- points.route_id -> day_id
ALTER TABLE points RENAME COLUMN route_id TO day_id;
ALTER INDEX uq_point_route_pos RENAME TO uq_point_day_pos;
ALTER INDEX idx_point_route RENAME TO idx_point_day;
ALTER TABLE points RENAME CONSTRAINT points_route_id_routes_id_fk TO points_day_id_days_id_fk;

-- route_legs.route_id -> day_id
ALTER TABLE route_legs RENAME COLUMN route_id TO day_id;
ALTER INDEX uq_leg_route_pos RENAME TO uq_leg_day_pos;
ALTER TABLE route_legs RENAME CONSTRAINT route_legs_route_id_routes_id_fk TO route_legs_day_id_days_id_fk;

COMMIT;
