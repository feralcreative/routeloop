CREATE TYPE "public"."ride_perm" AS ENUM('view', 'comment', 'suggest', 'edit');--> statement-breakpoint
ALTER TABLE "ride_members" ADD COLUMN "perm" "ride_perm" DEFAULT 'suggest' NOT NULL;