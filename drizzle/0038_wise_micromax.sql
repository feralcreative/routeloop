CREATE TYPE "public"."tips" AS ENUM('on', 'off');--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "tips" "tips" DEFAULT 'on' NOT NULL;