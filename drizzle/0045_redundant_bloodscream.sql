CREATE TYPE "public"."profile_visibility" AS ENUM('public', 'members', 'hidden');--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "profile_visibility" "profile_visibility" DEFAULT 'members' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "bio" varchar(280);--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "share_paddock" boolean DEFAULT false NOT NULL;