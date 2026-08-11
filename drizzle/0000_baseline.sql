CREATE TYPE "public"."invite_kind" AS ENUM('email', 'link', 'group');--> statement-breakpoint
CREATE TYPE "public"."point_kind" AS ENUM('stop', 'poi');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('google', 'github', 'cloudflare', 'email');--> statement-breakpoint
CREATE TYPE "public"."ride_source" AS ENUM('native', 'imported');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('pending', 'active', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."visibility" AS ENUM('public', 'unlisted', 'private');--> statement-breakpoint
CREATE TYPE "public"."waypoint_role" AS ENUM('start', 'finish', 'home', 'meet', 'split', 'gas', 'charge', 'break', 'camp', 'hotel', 'food', 'coffee', 'drinks', 'grocery', 'view', 'poi', 'wtf');--> statement-breakpoint
CREATE TABLE "days" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ride_id" bigint NOT NULL,
	"position" smallint NOT NULL,
	"title" varchar(150) DEFAULT '' NOT NULL,
	"color" varchar(7) DEFAULT '#0000cc' NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"distance_m" integer DEFAULT 0 NOT NULL,
	"duration_s" integer DEFAULT 0 NOT NULL,
	"twistiness_dpm" integer,
	"twistiness_best_dpm" integer
);
--> statement-breakpoint
CREATE TABLE "invite_redemptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"invite_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"consumed_seat" boolean DEFAULT false NOT NULL,
	"redeemed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"kind" "invite_kind" NOT NULL,
	"grants_survey" boolean DEFAULT false NOT NULL,
	"grants_beta" boolean DEFAULT false NOT NULL,
	"email" varchar(255),
	"label" varchar(120),
	"max_uses" integer DEFAULT 1 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"created_by" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ck_invite_grants_something" CHECK (grants_survey or grants_beta),
	CONSTRAINT "ck_invite_uses" CHECK (max_uses >= 1 and used_count >= 0 and used_count <= max_uses),
	CONSTRAINT "ck_invite_email_kind" CHECK (kind <> 'email' or email is not null)
);
--> statement-breakpoint
CREATE TABLE "login_tokens" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "points" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"day_id" bigint NOT NULL,
	"kind" "point_kind" NOT NULL,
	"position" smallint,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"name" varchar(255) DEFAULT '' NOT NULL,
	"description" varchar(2000),
	"roles" "waypoint_role"[] DEFAULT '{}'::waypoint_role[] NOT NULL,
	"duration_min" integer,
	"dist_from_start_m" integer,
	CONSTRAINT "ck_point_roles_max4" CHECK (cardinality(roles) <= 4),
	CONSTRAINT "ck_point_stop_pos" CHECK (kind <> 'stop' OR position IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "rides" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_id" bigint NOT NULL,
	"slug" varchar(22) NOT NULL,
	"title" varchar(150) NOT NULL,
	"description" varchar(2000),
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"source" "ride_source" DEFAULT 'imported' NOT NULL,
	"external_url" varchar(2048),
	"gpx_present" boolean DEFAULT false NOT NULL,
	"kml_bytes" integer DEFAULT 0 NOT NULL,
	"gpx_bytes" integer DEFAULT 0 NOT NULL,
	"source_format" varchar(10),
	"source_bytes" integer DEFAULT 0 NOT NULL,
	"size_bytes" integer GENERATED ALWAYS AS (kml_bytes + gpx_bytes + source_bytes) STORED,
	"total_miles" numeric(7, 1) DEFAULT '0' NOT NULL,
	"total_duration_s" integer DEFAULT 0 NOT NULL,
	"stop_count" smallint DEFAULT 0 NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_legs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"day_id" bigint NOT NULL,
	"position" smallint NOT NULL,
	"geometry" jsonb NOT NULL,
	"distance_m" integer DEFAULT 0 NOT NULL,
	"duration_s" integer DEFAULT 0 NOT NULL,
	"via_points" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey_responses" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"survey_version" smallint DEFAULT 1 NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"provider" "provider" NOT NULL,
	"provider_user_id" varchar(255) NOT NULL,
	"provider_email" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"first_name" varchar(80),
	"last_name" varchar(80),
	"address_line" varchar(255),
	"city" varchar(120),
	"state" varchar(80),
	"postal_code" varchar(20),
	"home_lat" double precision,
	"home_lng" double precision,
	"start_label" varchar(120),
	"start_address_line" varchar(255),
	"start_city" varchar(120),
	"start_state" varchar(80),
	"start_postal_code" varchar(20),
	"start_lat" double precision,
	"start_lng" double precision,
	"share_last_name" boolean DEFAULT false NOT NULL,
	"add_home_to_rides" boolean DEFAULT false NOT NULL,
	"share_payment_handles" boolean DEFAULT false NOT NULL,
	"cash_app" varchar(120),
	"venmo" varchar(120),
	"paypal" varchar(120),
	"zelle" varchar(120),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "username_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"username" varchar(30) NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" varchar(255),
	"display_name" varchar(255) NOT NULL,
	"username" varchar(30),
	"public_id" varchar(64),
	"avatar_url" varchar(512),
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"approved_email_at" timestamp,
	"survey_invited_at" timestamp,
	"can_manage_riders" boolean DEFAULT false NOT NULL,
	"quota_bytes" bigint DEFAULT 26214400 NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
ALTER TABLE "days" ADD CONSTRAINT "days_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD CONSTRAINT "invite_redemptions_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_redemptions" ADD CONSTRAINT "invite_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points" ADD CONSTRAINT "points_day_id_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rides" ADD CONSTRAINT "rides_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_legs" ADD CONSTRAINT "route_legs_day_id_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "username_history" ADD CONSTRAINT "username_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_day_ride_pos" ON "days" USING btree ("ride_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_redemption_invite_user" ON "invite_redemptions" USING btree ("invite_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_redemption_invite" ON "invite_redemptions" USING btree ("invite_id","redeemed_at");--> statement-breakpoint
CREATE INDEX "idx_redemption_user" ON "invite_redemptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invite_token" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_invite_created" ON "invites" USING btree ("created_by","created_at");--> statement-breakpoint
CREATE INDEX "idx_login_token_email" ON "login_tokens" USING btree ("email","created_at");--> statement-breakpoint
CREATE INDEX "idx_login_token_expires" ON "login_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_point_day_pos" ON "points" USING btree ("day_id","position");--> statement-breakpoint
CREATE INDEX "idx_point_day" ON "points" USING btree ("day_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_slug" ON "rides" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_owner" ON "rides" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_browse" ON "rides" USING btree ("visibility","created_at");--> statement-breakpoint
CREATE INDEX "idx_popular" ON "rides" USING btree ("visibility","view_count");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_leg_day_pos" ON "route_legs" USING btree ("day_id","position");--> statement-breakpoint
CREATE INDEX "idx_session_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_session_expires" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_survey_submitted" ON "survey_responses" USING btree ("submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_provider_identity" ON "user_identities" USING btree ("provider","provider_user_id");--> statement-breakpoint
CREATE INDEX "idx_user" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_username_history_user" ON "username_history" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_username_history_name" ON "username_history" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX "idx_user_status" ON "users" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_username_lower" ON "users" USING btree (lower("username"));