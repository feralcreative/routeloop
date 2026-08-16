ALTER TABLE "days" ADD COLUMN "alt_group" smallint;--> statement-breakpoint
ALTER TABLE "days" ADD COLUMN "alt_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_day_alt_active" ON "days" USING btree ("ride_id","alt_group") WHERE "days"."alt_active" and "days"."alt_group" is not null;