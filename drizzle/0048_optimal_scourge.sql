CREATE TYPE "public"."club_position" AS ENUM('member', 'secretary', 'road_captain', 'sergeant_at_arms', 'president', 'vice_president', 'treasurer');--> statement-breakpoint
CREATE TABLE "club_chapters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"club_id" bigint NOT NULL,
	"name" varchar(60) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_members" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"club_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"status" varchar(12) DEFAULT 'requested' NOT NULL,
	"position" "club_position" DEFAULT 'member' NOT NULL,
	"chapter_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_club_member_status" CHECK ("club_members"."status" in ('requested', 'member'))
);
--> statement-breakpoint
CREATE TABLE "clubs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"manager_id" bigint,
	"icon_bytes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "club_chapters" ADD CONSTRAINT "club_chapters_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_chapter_id_club_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."club_chapters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_club_chapter_name" ON "club_chapters" USING btree ("club_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_club_member" ON "club_members" USING btree ("club_id","user_id");--> statement-breakpoint
CREATE INDEX "ix_club_members_user" ON "club_members" USING btree ("user_id");