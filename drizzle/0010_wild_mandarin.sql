CREATE TYPE "public"."scheme" AS ENUM('system', 'light', 'dark');--> statement-breakpoint
CREATE TYPE "public"."theme" AS ENUM('default', 'contrast', 'colorblind');--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "theme" "theme" DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "scheme" "scheme" DEFAULT 'system' NOT NULL;