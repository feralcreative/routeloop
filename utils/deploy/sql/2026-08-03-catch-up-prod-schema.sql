-- Bring a deployed database up to src/db/schema.ts, by hand.
--
-- Why by hand: `drizzle-kit push` refuses to run unattended here. It wants to
-- add users_public_id_unique and stops to ask "do you want to truncate users
-- table?", which cannot be answered over a non-TTY SSH session. The deploy hook
-- passed --force to skip that prompt — which is exactly the flag that would
-- have answered *yes* to a truncate. Everything below is additive: no DROP, no
-- TRUNCATE, no type changes.
--
-- Prod had drifted three sprints behind because the post-deploy hook was
-- non-fatal: a failed push printed a warning and the deploy still reported
-- success. Fixed alongside this in utils/deploy/hooks/post-deploy.sh.
--
--   sprint 04  users.public_id, username_history
--   sprint 06  user_profiles.start_* (the public starting point)
--   sprint 07  routes.twistiness_dpm, routes.twistiness_best_dpm
--
-- Every statement is IF NOT EXISTS or guarded, so this is safe to re-run and
-- safe to run against a database that is already partly caught up.
--
-- Run it as one transaction:
--   docker exec -i tankbag-db psql -U tankbag -d tankbag -v ON_ERROR_STOP=1 \
--     --single-transaction -f - < this-file.sql

BEGIN;

-- --------------------------------------------------------------- sprint 04 --

ALTER TABLE users ADD COLUMN IF NOT EXISTS public_id varchar(64);

-- Backfill before the unique constraint goes on, or existing rows collide on
-- NULL. publicIdFor() is {lowercase-username}-{YYMMDDTHHMMZ} from created_at in
-- UTC; see src/auth/username.ts. Reproduced here rather than run through the
-- app because these rows predate the column and will never pass through it.
UPDATE users
   SET public_id = lower(username) || '-' || to_char(created_at AT TIME ZONE 'UTC', 'YYMMDD"T"HH24MI"Z"')
 WHERE public_id IS NULL
   AND username IS NOT NULL;

-- A user with no username yet (signed up, never reached /choose-name) has no
-- public id to derive. Left NULL: the constraint below is NULLS DISTINCT, so
-- any number of them coexist, and claimUsername() fills it in on the way past.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_public_id_unique;
ALTER TABLE users ADD CONSTRAINT users_public_id_unique UNIQUE (public_id);

CREATE TABLE IF NOT EXISTS username_history (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username    varchar(30) NOT NULL,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_username_history_user ON username_history (user_id);
CREATE INDEX IF NOT EXISTS idx_username_history_name ON username_history (lower(username));

-- Seed the current handle as each rider's first history row, so the 30-day hold
-- and the "names you have used before" list have a starting point rather than
-- treating every existing name as never claimed.
INSERT INTO username_history (user_id, username, claimed_at)
SELECT u.id, u.username, u.created_at
  FROM users u
 WHERE u.username IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM username_history h WHERE h.user_id = u.id);

-- --------------------------------------------------------------- sprint 06 --
-- The public starting point: where a *shared* ride begins instead of the
-- rider's front door.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS start_label        varchar(120);
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS start_address_line varchar(255);
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS start_city         varchar(120);
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS start_state        varchar(80);
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS start_postal_code  varchar(20);
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS start_lat          double precision;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS start_lng          double precision;

-- --------------------------------------------------------------- sprint 07 --
-- Twistiness. Nullable on purpose: NULL means "not measured", which is a
-- different claim from 0 ("the road is straight"). Existing rows stay NULL
-- until utils/backfill-twistiness.ts runs.

ALTER TABLE routes ADD COLUMN IF NOT EXISTS twistiness_dpm      integer;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS twistiness_best_dpm integer;

COMMIT;
