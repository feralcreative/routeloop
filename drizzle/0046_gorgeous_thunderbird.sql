-- PostGIS (#37). The image has carried it since #417; this turns it on.
CREATE EXTENSION IF NOT EXISTS postgis;--> statement-breakpoint
CREATE TABLE "road_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"reporter_id" bigint NOT NULL,
	"kind" varchar(16) NOT NULL,
	"note" varchar(400) DEFAULT '' NOT NULL,
	"at" geometry(Point, 4326) NOT NULL,
	"season_start" smallint,
	"season_end" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "ck_road_report_kind" CHECK ("road_reports"."kind" in ('surface', 'closure', 'hazard')),
	CONSTRAINT "ck_road_report_season" CHECK (("road_reports"."season_start" is null) = ("road_reports"."season_end" is null) and ("road_reports"."season_start" is null or "road_reports"."kind" = 'closure'))
);
--> statement-breakpoint
CREATE TABLE "route_tracks" (
	"route_id" bigint PRIMARY KEY NOT NULL,
	"ride_id" bigint NOT NULL,
	"track" geometry(LineString, 4326) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "road_reports" ADD CONSTRAINT "road_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_tracks" ADD CONSTRAINT "route_tracks_route_id_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_tracks" ADD CONSTRAINT "route_tracks_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_road_reports_at" ON "road_reports" USING gist ("at");--> statement-breakpoint
CREATE INDEX "ix_road_reports_reporter" ON "road_reports" USING btree ("reporter_id");--> statement-breakpoint
CREATE INDEX "ix_route_tracks_track" ON "route_tracks" USING gist ("track");--> statement-breakpoint
CREATE INDEX "ix_route_tracks_ride" ON "route_tracks" USING btree ("ride_id");--> statement-breakpoint
-- Every stored route's track, built from its legs the way refreshRouteTracks() in
-- src/maps/route-track.ts builds one on save. A route with fewer than two vertices
-- has no line and gets no row.
INSERT INTO "route_tracks" ("route_id", "ride_id", "track")
SELECT r.id, r.ride_id,
       ST_SetSRID(ST_MakeLine(ST_MakePoint((v.c->>0)::float8, (v.c->>1)::float8) ORDER BY l.position, v.ord), 4326)
FROM "routes" r
JOIN "route_legs" l ON l.route_id = r.id
CROSS JOIN LATERAL jsonb_array_elements(l.geometry) WITH ORDINALITY AS v(c, ord)
GROUP BY r.id, r.ride_id
HAVING count(*) >= 2;
