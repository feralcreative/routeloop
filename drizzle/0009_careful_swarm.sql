CREATE TYPE "public"."date_format" AS ENUM('en-US', 'en-GB', 'en-CA');--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "date_format" date_format DEFAULT 'en-US' NOT NULL;