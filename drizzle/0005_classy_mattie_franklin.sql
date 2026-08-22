ALTER TABLE "rides" ADD COLUMN "thumb_hash" varchar(32);--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "thumb_built_at" timestamp;--> statement-breakpoint
CREATE INDEX "idx_thumb_stale" ON "rides" USING btree ("updated_at") WHERE "rides"."thumb_built_at" is null or "rides"."updated_at" > "rides"."thumb_built_at";