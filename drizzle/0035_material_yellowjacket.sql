CREATE TABLE "notification_prefs" (
	"user_id" bigint NOT NULL,
	"event" varchar(40) NOT NULL,
	"channel" varchar(16) NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_user_id_event_channel_pk" PRIMARY KEY("user_id","event","channel")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"event" varchar(40) NOT NULL,
	"title" varchar(160) NOT NULL,
	"body" varchar(400) NOT NULL,
	"url" varchar(512),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"delivered_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "purge_warned_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "quota_warned_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "purge_warned_at" timestamp;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notifications_pending" ON "notifications" USING btree ("user_id","created_at") WHERE "notifications"."delivered_at" is null;