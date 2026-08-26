DROP INDEX "uq_place_group_name";--> statement-breakpoint
ALTER TABLE "place_groups" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "place_groups" ADD COLUMN "purge_after" timestamp;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "purge_after" timestamp;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "purge_after" timestamp;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "purge_started_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_place_groups_purge_due" ON "place_groups" USING btree ("purge_after") WHERE "place_groups"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "idx_places_purge_due" ON "places" USING btree ("purge_after") WHERE "places"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "idx_rides_purge_due" ON "rides" USING btree ("purge_after") WHERE "rides"."deleted_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_place_group_name" ON "place_groups" USING btree ("owner_id","name") WHERE "place_groups"."deleted_at" is null;