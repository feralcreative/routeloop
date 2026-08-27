CREATE TABLE "alt_votes" (
	"ride_id" bigint NOT NULL,
	"day_uid" varchar(12) NOT NULL,
	"user_id" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "alt_votes_ride_id_day_uid_user_id_pk" PRIMARY KEY("ride_id","day_uid","user_id")
);
--> statement-breakpoint
/*
  HAND-EDITED. The differ emitted this as a single

      ALTER TABLE "days" ADD COLUMN "uid" varchar(12) NOT NULL;

  which fails outright on a populated table: there is no default, so every
  existing row would violate the constraint the moment it is added. Three
  statements instead — add nullable, backfill, constrain — which is the worked
  shape AGENTS.md describes for a NOT NULL on a populated column.

  The backfill value has to satisfy /^[a-z0-9]{12}$/, which is what isUid() in
  src/maps/uid.ts enforces on the way back in. md5() is lowercase hex and hex is
  a subset of that alphabet, so the first twelve characters of one are a valid
  uid by construction — no extension, no character class to get wrong, and
  nothing to install. Seeded with the row id as well as random() so two days
  cannot collide even in the same microsecond.
*/
ALTER TABLE "days" ADD COLUMN "uid" varchar(12);--> statement-breakpoint
UPDATE "days" SET "uid" = substr(md5(random()::text || '-' || "id"::text), 1, 12) WHERE "uid" IS NULL;--> statement-breakpoint
ALTER TABLE "days" ALTER COLUMN "uid" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "rides" ADD COLUMN "alt_votes_close_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alt_votes" ADD CONSTRAINT "alt_votes_ride_id_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alt_votes" ADD CONSTRAINT "alt_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_alt_vote_ride" ON "alt_votes" USING btree ("ride_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_day_ride_uid" ON "days" USING btree ("ride_id","uid");--> statement-breakpoint
/*
  HAND-ADDED. The differ cannot know this: putting every existing ride's owner
  on its own roster is a DATA migration with no schema change behind it, and
  without it every ride that predates this branch has an empty roster while its
  owner is standing right there.

  It is what makes "who is on this ride" one question instead of two. A reader
  that has to ask about rides.owner_id separately from ride_members is a reader
  that can forget to, and the one that forgets shows a ride nobody is on.

  'going' rather than the 'invited' default: the owner planned it.

  ON CONFLICT DO NOTHING so a re-run is free. uq_ride_member is a plain unique
  index over two columns with no predicate, so a bare column list infers it —
  unlike uq_place_group_name, which is partial and needs its WHERE restated.
*/
INSERT INTO "ride_members" ("ride_id", "rider_id", "role", "rsvp")
SELECT "id", "owner_id", 'owner', 'going' FROM "rides"
ON CONFLICT ("ride_id", "rider_id") DO NOTHING;
