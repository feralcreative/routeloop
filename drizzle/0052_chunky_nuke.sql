-- One key per (rider, provider). Hand-ordered: the generator put the new primary
-- key ahead of the column it names and could not name the old one, which is
-- Postgres's default for an inline PRIMARY KEY on this table.
ALTER TABLE "ai_keys" ADD COLUMN "provider" varchar(12) DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_keys" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_keys" DROP CONSTRAINT "ai_keys_pkey";--> statement-breakpoint
ALTER TABLE "ai_keys" ADD CONSTRAINT "ai_keys_user_id_provider_pk" PRIMARY KEY("user_id","provider");--> statement-breakpoint
ALTER TABLE "ai_keys" ADD CONSTRAINT "ck_ai_keys_provider" CHECK ("ai_keys"."provider" in ('anthropic', 'openai'));
