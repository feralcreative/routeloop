CREATE TYPE "public"."feedback_kind" AS ENUM('bug', 'idea', 'question');--> statement-breakpoint
CREATE TYPE "public"."feedback_state" AS ENUM('pending', 'published', 'declined', 'duplicate', 'spam');--> statement-breakpoint
CREATE TYPE "public"."feedback_status" AS ENUM('new', 'needs_info', 'confirmed', 'planned', 'in_progress', 'shipped', 'on_list', 'not_doing', 'no_repro', 'by_design');--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"public_id" varchar(22) NOT NULL,
	"author_id" bigint NOT NULL,
	"kind" "feedback_kind" NOT NULL,
	"state" "feedback_state" DEFAULT 'pending' NOT NULL,
	"status" "feedback_status" DEFAULT 'new' NOT NULL,
	"title" varchar(150),
	"body" varchar(4000) NOT NULL,
	"context" varchar(2000),
	"area" varchar(40),
	"frequency" varchar(20),
	"impact" varchar(20),
	"want_count" integer DEFAULT 0 NOT NULL,
	"priority" smallint,
	"owner_note" varchar(2000),
	"public_response" varchar(2000),
	"duplicate_of" bigint,
	"reply_ok" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"published_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "feedback_attachments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"feedback_id" bigint NOT NULL,
	"storage_key" varchar(255) NOT NULL,
	"mime" varchar(60) NOT NULL,
	"bytes" integer DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_diagnostics" (
	"feedback_id" bigint PRIMARY KEY NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_votes" (
	"feedback_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_votes_feedback_id_user_id_pk" PRIMARY KEY("feedback_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_duplicate_of_feedback_id_fk" FOREIGN KEY ("duplicate_of") REFERENCES "public"."feedback"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_attachments" ADD CONSTRAINT "feedback_attachments_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_diagnostics" ADD CONSTRAINT "feedback_diagnostics_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_votes" ADD CONSTRAINT "feedback_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feedback_public_id" ON "feedback" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_board" ON "feedback" USING btree ("state","kind","want_count");--> statement-breakpoint
CREATE INDEX "idx_feedback_queue" ON "feedback" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "idx_feedback_author" ON "feedback" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_attachment" ON "feedback_attachments" USING btree ("feedback_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_vote_user" ON "feedback_votes" USING btree ("user_id");