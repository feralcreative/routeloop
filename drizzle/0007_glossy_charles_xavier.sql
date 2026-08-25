CREATE TABLE "place_groups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_id" bigint NOT NULL,
	"name" varchar(80) NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_id" bigint NOT NULL,
	"group_id" bigint,
	"name" varchar(255) NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"roles" "waypoint_role"[] DEFAULT '{}'::waypoint_role[] NOT NULL,
	"phone" varchar(40),
	"address" varchar(300),
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ck_place_roles_max4" CHECK (cardinality(roles) <= 4)
);
--> statement-breakpoint
ALTER TABLE "place_groups" ADD CONSTRAINT "place_groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_group_id_place_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."place_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_place_group_name" ON "place_groups" USING btree ("owner_id","name");--> statement-breakpoint
CREATE INDEX "idx_place_group_owner" ON "place_groups" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_place_owner" ON "places" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_place_group" ON "places" USING btree ("group_id");