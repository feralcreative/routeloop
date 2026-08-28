CREATE TYPE "public"."motion" AS ENUM('system', 'always', 'never');--> statement-breakpoint
CREATE TYPE "public"."units" AS ENUM('imperial', 'metric');--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "motion" "motion" DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "units" "units" DEFAULT 'imperial' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "phone" varchar(40);--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "share_phone" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "instagram" varchar(120);--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "facebook" varchar(120);--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "youtube" varchar(120);--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "strava" varchar(120);--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "share_socials" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "avatar_bytes" integer DEFAULT 0 NOT NULL;