CREATE TYPE "public"."duration_format" AS ENUM('hours', 'hm', 'minutes');--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "duration_format" "duration_format" DEFAULT 'hours' NOT NULL;