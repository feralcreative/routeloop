/*
  FULLY ADDITIVE AND NEEDS NO BACKFILL, which is worth stating because the last
  two migrations both did.

  Every new column is nullable or carries a default that is already a true
  description of every existing row: days.subgroup_id null means "everyone rides
  this", which is what every day predating #67 is; points.slack_min null means
  nobody set any; rides.time_anchor defaults to 'departure', which is the only
  anchor a ride with no subgroups can have.

  Read it anyway. The four `set null` foreign keys are the deliberate half:
  deleting a subgroup must un-group its days and its riders rather than destroy
  them, and cascade there would take a rider's planned road away because they
  renamed a group wrong.
*/
CREATE TYPE "public"."time_anchor" AS ENUM('departure', 'meet', 'arrival');--> statement-breakpoint
CREATE TABLE "ride_subgroups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ride_id" bigint NOT NULL,
	"uid" varchar(12) NOT NULL,
	"name" varchar(80) NOT NULL,
	"color" varchar(7) DEFAULT '#0066cc' NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "days" ADD COLUMN "subgroup_id" bigint;--> statement-breakpoint
ALTER TABLE "points" ADD COLUMN "slack_min" integer;--> statement-breakpoint
ALTER TABLE "ride_members" ADD COLUMN "subgroup_id" bigint;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "primary_subgroup_id" bigint;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "trunk_subgroup_id" bigint;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "time_anchor" time_anchor DEFAULT 'departure' NOT NULL;--> statement-breakpoint
ALTER TABLE "ride_subgroups" ADD CONSTRAINT "ride_subgroups_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_subgroup_ride_uid" ON "ride_subgroups" USING btree ("ride_id","uid");--> statement-breakpoint
CREATE INDEX "idx_subgroup_ride" ON "ride_subgroups" USING btree ("ride_id");--> statement-breakpoint
ALTER TABLE "days" ADD CONSTRAINT "days_subgroup_id_ride_subgroups_id_fk" FOREIGN KEY ("subgroup_id") REFERENCES "public"."ride_subgroups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_members" ADD CONSTRAINT "ride_members_subgroup_id_ride_subgroups_id_fk" FOREIGN KEY ("subgroup_id") REFERENCES "public"."ride_subgroups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_primary_subgroup_id_ride_subgroups_id_fk" FOREIGN KEY ("primary_subgroup_id") REFERENCES "public"."ride_subgroups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_trunk_subgroup_id_ride_subgroups_id_fk" FOREIGN KEY ("trunk_subgroup_id") REFERENCES "public"."ride_subgroups"("id") ON DELETE set null ON UPDATE no action;