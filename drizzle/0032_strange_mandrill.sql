CREATE TYPE "public"."clock" AS ENUM('locale', 'h12', 'h24');--> statement-breakpoint
CREATE TYPE "public"."volume_units" AS ENUM('auto', 'gallons', 'liters');--> statement-breakpoint
ALTER TABLE "bikes" ADD COLUMN "tank_ml" integer;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "clock" "clock" DEFAULT 'locale' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "volume_units" "volume_units" DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "avoid_places" varchar(1000);--> statement-breakpoint
ALTER TABLE "bikes" ADD CONSTRAINT "ck_bike_tank" CHECK ("bikes"."tank_ml" is null or ("bikes"."tank_ml" > 0 and "bikes"."tank_ml" <= 100000));