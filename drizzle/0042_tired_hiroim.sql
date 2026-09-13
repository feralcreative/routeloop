ALTER TABLE "rides" ADD COLUMN "vehicle" varchar(20);--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "power" varchar(20);--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "vehicle" varchar(20);--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "power" varchar(20);--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "jargon" jsonb;