CREATE TABLE "ai_keys" (
	"user_id" bigint PRIMARY KEY NOT NULL,
	"ciphertext" varchar(512) NOT NULL,
	"iv" varchar(32) NOT NULL,
	"tag" varchar(32) NOT NULL,
	"last4" varchar(8) NOT NULL,
	"model" varchar(40) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"user_id" bigint NOT NULL,
	"day" varchar(10) NOT NULL,
	"source" varchar(8) NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"google_calls" integer DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_user_id_day_source_pk" PRIMARY KEY("user_id","day","source"),
	CONSTRAINT "ck_ai_usage_source" CHECK ("ai_usage"."source" in ('free', 'byo', 'mcp'))
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" varchar(40) PRIMARY KEY NOT NULL,
	"name" varchar(120) DEFAULT '' NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" varchar(64) PRIMARY KEY NOT NULL,
	"client_id" varchar(40) NOT NULL,
	"user_id" bigint NOT NULL,
	"redirect_uri" varchar(2000) NOT NULL,
	"code_challenge" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"kind" varchar(8) NOT NULL,
	"client_id" varchar(40) NOT NULL,
	"user_id" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "ck_oauth_token_kind" CHECK ("oauth_tokens"."kind" in ('access', 'refresh'))
);
--> statement-breakpoint
ALTER TABLE "ai_keys" ADD CONSTRAINT "ai_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_ai_usage_day" ON "ai_usage" USING btree ("day","source");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_oauth_token_hash" ON "oauth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_oauth_tokens_user" ON "oauth_tokens" USING btree ("user_id");