CREATE TABLE "ride_comments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ride_id" bigint NOT NULL,
	"author_id" bigint NOT NULL,
	"point_uid" varchar(12),
	"point_label" varchar(200),
	"body" varchar(4000) NOT NULL,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ride_comments" ADD CONSTRAINT "ride_comments_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ride_comments" ADD CONSTRAINT "ride_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ride_comment_ride" ON "ride_comments" USING btree ("ride_id","created_at");