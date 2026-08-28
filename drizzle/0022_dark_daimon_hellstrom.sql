CREATE TYPE "public"."suggestion_outcome" AS ENUM('accepted', 'discarded', 'withdrawn');--> statement-breakpoint
CREATE TABLE "ride_suggestions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ride_id" bigint NOT NULL,
	"author_id" bigint NOT NULL,
	"day_uid" varchar(12) NOT NULL,
	"payload" jsonb NOT NULL,
	"base_fingerprint" varchar(64) NOT NULL,
	"note" varchar(2000),
	"resolved_at" timestamp,
	"outcome" "suggestion_outcome",
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ride_suggestions" ADD CONSTRAINT "ride_suggestions_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_suggestions" ADD CONSTRAINT "ride_suggestions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ride_suggestion_ride" ON "ride_suggestions" USING btree ("ride_id","created_at");