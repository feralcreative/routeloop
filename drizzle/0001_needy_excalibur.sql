ALTER TABLE "invites" DROP CONSTRAINT "invites_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "invites" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "purge_after" timestamp;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "purge_started_at" timestamp;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_users_purge_due" ON "users" USING btree ("purge_after");