CREATE TYPE "public"."member_state" AS ENUM('draft', 'pending_friend', 'pending_signup', 'invited', 'declined');--> statement-breakpoint
ALTER TYPE "public"."user_status" ADD VALUE 'placeholder';--> statement-breakpoint
CREATE TABLE "ride_invites" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ride_id" bigint NOT NULL,
	"placeholder_id" bigint,
	"email" varchar(255),
	"token_hash" varchar(64),
	"created_by" bigint,
	"sent_at" timestamp,
	"redeemed_at" timestamp,
	"redeemed_by" bigint,
	"declined_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ride_members" ADD COLUMN "state" "member_state" DEFAULT 'invited' NOT NULL;--> statement-breakpoint
ALTER TABLE "ride_invites" ADD CONSTRAINT "ride_invites_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_invites" ADD CONSTRAINT "ride_invites_placeholder_id_users_id_fk" FOREIGN KEY ("placeholder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_invites" ADD CONSTRAINT "ride_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_invites" ADD CONSTRAINT "ride_invites_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ride_invite_token" ON "ride_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ride_invite_placeholder" ON "ride_invites" USING btree ("placeholder_id");--> statement-breakpoint
CREATE INDEX "idx_ride_invite_ride" ON "ride_invites" USING btree ("ride_id");