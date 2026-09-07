CREATE TABLE "day_riders" (
	"ride_id" bigint NOT NULL,
	"day_uid" varchar(12) NOT NULL,
	"rider_id" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "day_riders_ride_id_day_uid_rider_id_pk" PRIMARY KEY("ride_id","day_uid","rider_id")
);
--> statement-breakpoint
ALTER TABLE "day_riders" ADD CONSTRAINT "day_riders_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_riders" ADD CONSTRAINT "day_riders_rider_id_users_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_day_rider_ride" ON "day_riders" USING btree ("ride_id");