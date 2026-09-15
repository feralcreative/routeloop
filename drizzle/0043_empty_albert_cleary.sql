CREATE TYPE "public"."map_scheme" AS ENUM('follow', 'light', 'dark');--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "map_scheme" "map_scheme" DEFAULT 'follow' NOT NULL;