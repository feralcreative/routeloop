ALTER TABLE "user_profiles" ADD COLUMN "tour_ride_id" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_guide" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_tour_ride_id_rides_id_fk" FOREIGN KEY ("tour_ride_id") REFERENCES "public"."rides"("id") ON DELETE set null ON UPDATE no action;