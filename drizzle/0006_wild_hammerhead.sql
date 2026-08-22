CREATE TABLE "point_details" (
	"ride_id" bigint NOT NULL,
	"uid" varchar(12) NOT NULL,
	"confirmation" varchar(120),
	"check_in_at" timestamp with time zone,
	"check_out_at" timestamp with time zone,
	"phone" varchar(40),
	"address" varchar(300),
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" varchar(2000),
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "point_details_ride_id_uid_pk" PRIMARY KEY("ride_id","uid")
);
--> statement-breakpoint
--
-- points.uid, in three steps rather than the one the differ generated.
--
-- drizzle-kit emitted `ADD COLUMN "uid" varchar(12) NOT NULL` as a single
-- statement. That fails outright on a populated table: every existing row would
-- need a value the statement does not supply. Riders hold points that cannot be
-- rebuilt from an upload, so this is hand-written per the rule in AGENTS.md —
-- read the generated SQL and rewrite it when the differ guesses wrong.
--
-- The backfill derives each uid from the row's own id rather than from
-- random(): it is deterministic, so re-running this migration against a
-- half-migrated database produces the same values, and it cannot collide,
-- because `id` is already unique across the whole table and therefore unique
-- within any one day. Twelve hex characters covers ids up to 2^48.
--
-- The unique index comes last, after every row has a value.
ALTER TABLE "points" ADD COLUMN "uid" varchar(12);--> statement-breakpoint
UPDATE "points" SET "uid" = lpad(to_hex("id"), 12, '0') WHERE "uid" IS NULL;--> statement-breakpoint
ALTER TABLE "points" ALTER COLUMN "uid" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "point_details" ADD CONSTRAINT "point_details_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_point_details_ride" ON "point_details" USING btree ("ride_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_point_day_uid" ON "points" USING btree ("day_id","uid");
