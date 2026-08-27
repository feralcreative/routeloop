CREATE TABLE "follows" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"follower_id" bigint NOT NULL,
	"followee_id" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ck_follow_not_self" CHECK ("follows"."follower_id" <> "follows"."followee_id")
);
--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_id_users_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_id_users_id_fk" FOREIGN KEY ("followee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_follow_pair" ON "follows" USING btree ("follower_id","followee_id");--> statement-breakpoint
CREATE INDEX "idx_follow_followee" ON "follows" USING btree ("followee_id");