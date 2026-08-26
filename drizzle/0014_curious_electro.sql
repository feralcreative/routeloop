CREATE TYPE "public"."friendship_status" AS ENUM('pending', 'accepted', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."ride_role" AS ENUM('owner', 'rider');--> statement-breakpoint
CREATE TYPE "public"."rsvp" AS ENUM('invited', 'going', 'maybe', 'declined');--> statement-breakpoint
ALTER TYPE "public"."visibility" ADD VALUE 'friends';--> statement-breakpoint
CREATE TABLE "friendships" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"rider_a" bigint NOT NULL,
	"rider_b" bigint NOT NULL,
	"status" "friendship_status" DEFAULT 'pending' NOT NULL,
	"requested_by" bigint NOT NULL,
	"blocked_by" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ck_friendship_order" CHECK ("friendships"."rider_a" < "friendships"."rider_b")
);
--> statement-breakpoint
CREATE TABLE "ride_members" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ride_id" bigint NOT NULL,
	"rider_id" bigint NOT NULL,
	"role" "ride_role" DEFAULT 'rider' NOT NULL,
	"rsvp" "rsvp" DEFAULT 'invited' NOT NULL,
	"invited_by" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_rider_a_users_id_fk" FOREIGN KEY ("rider_a") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_rider_b_users_id_fk" FOREIGN KEY ("rider_b") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_blocked_by_users_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_members" ADD CONSTRAINT "ride_members_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_members" ADD CONSTRAINT "ride_members_rider_id_users_id_fk" FOREIGN KEY ("rider_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_members" ADD CONSTRAINT "ride_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_friendship_pair" ON "friendships" USING btree ("rider_a","rider_b");--> statement-breakpoint
CREATE INDEX "idx_friendship_b" ON "friendships" USING btree ("rider_b");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ride_member" ON "ride_members" USING btree ("ride_id","rider_id");--> statement-breakpoint
CREATE INDEX "idx_ride_member_rider" ON "ride_members" USING btree ("rider_id","ride_id");