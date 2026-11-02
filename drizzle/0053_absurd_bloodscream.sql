CREATE TABLE "ride_briefs" (
	"ride_id" bigint PRIMARY KEY NOT NULL,
	"brief" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" bigint
);
--> statement-breakpoint
ALTER TABLE "ride_briefs" ADD CONSTRAINT "ride_briefs_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_briefs" ADD CONSTRAINT "ride_briefs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;