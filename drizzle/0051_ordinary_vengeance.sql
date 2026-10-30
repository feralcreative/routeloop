ALTER TABLE "oauth_tokens" ADD COLUMN "family_id" varchar(32);--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "used_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "ix_oauth_tokens_family" ON "oauth_tokens" USING btree ("family_id");