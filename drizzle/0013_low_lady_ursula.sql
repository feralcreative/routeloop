CREATE TYPE "public"."fuel_type" AS ENUM('gas', 'electric');--> statement-breakpoint
CREATE TABLE "bikes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_id" bigint NOT NULL,
	"nickname" varchar(80),
	"make" varchar(60),
	"model" varchar(80),
	"year" smallint,
	"fuel_type" "fuel_type" DEFAULT 'gas' NOT NULL,
	"usable_range_m" integer,
	"comfort_range_m" integer,
	"photo_hash" varchar(32),
	"photo_bytes" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ck_bike_range" CHECK ("bikes"."usable_range_m" is null or ("bikes"."usable_range_m" > 0 and "bikes"."usable_range_m" <= 2000000)),
	CONSTRAINT "ck_bike_comfort" CHECK ("bikes"."comfort_range_m" is null or ("bikes"."comfort_range_m" > 0 and "bikes"."comfort_range_m" <= 2000000))
);
--> statement-breakpoint
ALTER TABLE "bikes" ADD CONSTRAINT "bikes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bike_owner" ON "bikes" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bike_default" ON "bikes" USING btree ("owner_id") WHERE "bikes"."is_default";