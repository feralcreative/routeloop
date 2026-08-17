# Database

`src/db/schema.ts` is the source of truth. This file covers what the tables are for and how a change to them reaches a database.

## The tables

Read `schema.ts` for columns; this is what each one is *for* and the constraints that are not obvious from a type.

- **`users`**—identity, `quota_bytes`, and `used_bytes`, a denormalized cache incremented on import and decremented on delete with no reconciler, so it drifts. The dashboard computes the authoritative sum alongside it and reports the disagreement.
- **`user_identities`**—one row per login method, so a rider can arrive by Google or by magic link and land on the same account. Legacy Google and GitHub identity rows remain valid.
- **`sessions`**—the PK is the SHA-256 hash of the browser token, never the token.
- **`rides`**—`owner_id`, unguessable `slug`, `title`, `description`, `visibility` (public / unlisted / private), `source` (native | imported), `external_url`, the byte columns plus generated `size_bytes`, and the caches `total_miles`, `total_duration_s`, `stop_count`.
- **`days`**—`ride_id`, `position`, `title`, `color` (feeds the legend), `start_at`/`end_at` (nullable), `distance_m`, `duration_s`, and the alternates pair `alt_group` (nullable smallint) / `alt_active` (not null, default true). A position, not a calendar date: two days may share a date, and an undated ride still has days.
- **`points`**—`day_id`, `kind` (stop | poi), `position` (stop order, null for POIs), `lat`/`lng`, `name`, `description`, `roles waypoint_role[]` (at most 4, checked by the database), `duration_min` (null means no duration), `dist_from_start_m` (server-computed).
- **`route_legs`**—`day_id`, `position` (leg *i* joins stop *i* to *i+1*), `geometry jsonb` as `[lng,lat][]` at 6 decimals, `distance_m`, `duration_s`, `via_points jsonb` (the ephemeral shaping waypoints).
- **`user_profiles`**—the FK to `users` *is* the PK, so there is one profile per rider and no surrogate id to keep in sync. Name, address and the geocoded home, the public start place, the sharing toggles and the payment handles. Also `duration_format`, which is a *display* preference and not a storage one: `points.duration_min` stays integer minutes whatever it says. **A rider may have no row here at all**, so every reader has to have an answer for that—see `toDurationFormat()` in `src/maps/duration.ts`, and note that the write path upserts rather than updates.

**`alt_group` is a within-payload partition key, not a stable id.** Two or more days sharing one non-null `alt_group` are alternatives for the same stretch and exactly one of them has `alt_active`; only that one counts toward `rides.total_miles`, `rides.stop_count` or anything on the dashboard. The value is renumbered densely from 0 on every save, so nothing may store it or join to it—that is forced rather than chosen, because the `PUT` deletes and reinserts every day and no `days.id` survives a save. `src/maps/alternates.ts` owns every rule about the pair; `resolveAltGroups()` is total and repairs rather than rejects, because a group of one is what a rider passes through the instant they delete one of a pair. The partial index `uq_day_alt_active` is a tripwire for a bug in that function, not a gate.

**A group member is exactly one day, so a multi-day alternate cannot be expressed.** "Day 3 direct, or days 3b and 3c the long way with an overnight" has no representation here. Decided knowingly on 2026-08-16 in favour of the simpler shape; adding it later means a third `alt_branch` column and a branch filter, not a feature toggle.

**`MAX_DAYS = 31` counts alternates, not just real days.** A 31-day ride therefore cannot carry one. Accepted 2026-08-16 rather than fixed: the cap bounds payload size and insert cost, and excluding losing alternates from it would mean resolving groups before counting instead of checking an array length. A month-long ride wanting alternates is a case that has not come up.

Enums: `provider`, `visibility`, `ride_source`, `point_kind`, `duration_format`, and `waypoint_role`—the 17 roles, which must stay in sync with `src/maps/roles.ts`. `duration_format` has the same requirement against `DURATION_FORMATS` in `src/maps/duration.ts`.

**`rides.size_bytes` is generated as the sum of every byte column.** A column missing from that expression leaks quota on every delete, silently and permanently, because the app increments `used_bytes` on import and the database decrements it from `size_bytes` on delete.

**One rendering path, and now one shape.** Every ride—imported or native—stores one leg per pair of consecutive stops. An import used to hold its whole track in a single leg at position 0; it is split at the stops on the way in now (`src/maps/track-split.ts`), and `utils/split-imported-legs.ts` brought the existing rows across. Viewers still render `concat(legs)` per day.

## Migrations

`src/db/schema.ts` is the source of truth for the schema. Since 2026-08-10 changes to it reach a database through **generated migration files** in [drizzle/](../drizzle/), committed to the repo and applied with `drizzle-kit migrate`. This replaced `drizzle-kit push`.

## Why this changed

`push` diffs `schema.ts` against a live database and applies the difference. It works, but it leaves **no artifact**: the change exists in the database it was run against and nowhere else. Two consequences, both of which actually happened:

- **Development across two machines broke on every schema change.** A `git pull` brought the new `schema.ts` and the code that queries it, while the local Postgres kept yesterday's shape. It surfaced as a runtime 500 on whichever machine had not run `push`—`column users.survey_invited_at does not exist`, in an OAuth callback, on 2026-08-10.
- **Schema changes were invisible in review.** A pull request that added a column showed the Drizzle declaration and no DDL, so there was nothing to read for what would run against production data.

Generated migrations fix both: the SQL is in the diff, `git pull` carries it, and `migrate` applies exactly what has not run yet.

`migrate` also **cannot prompt**, which matters more here than it looks. `push`'s interactive questions are what made the deploy step unrunnable over SSH, and what made `--force` tempting—and `--force` does not mean "unattended", it means "answer yes to everything", including "do you want to truncate the users table?" That prompt was one drizzle-kit version away from emptying production's `users` table. There is no equivalent flag on `migrate` because there is nothing to answer.

## Everyday workflow

Change `src/db/schema.ts`, then:

```bash
npm run db:generate        # writes drizzle/NNNN_name.sql from the schema diff
npm run db:migrate         # applies pending migrations to DATABASE_URL
```

**Read the generated SQL before applying it.** Generation is mechanical, not careful: a rename looks to the differ like a drop plus an add, and it will happily write `DROP COLUMN`. Rewriting the generated file is normal and expected—add a backfill `UPDATE` ahead of a `NOT NULL`, turn a drop-and-add into an `ALTER TABLE … RENAME COLUMN`. Edit it **before** it has been applied anywhere; once a migration has run against a database its hash is recorded, and editing it then means the file and the databases disagree.

Commit the migration together with the `schema.ts` change that produced it. `drizzle/meta/` goes with it—that snapshot is what the next `generate` diffs against, so leaving it out makes the following migration wrong.

`npm run dev` runs `db:migrate` first, via `predev`. That is the whole point of the exercise: switching machines and starting the dev server is enough to bring the local database in line, with no step to remember. An already-current database makes it a no-op.

## Two machines

The failure this workflow exists to prevent needs nothing more than the everyday flow above—pull, then `npm run dev`. What migrations do **not** synchronize is data: rides and accounts stay per-machine. For that see [utils/seed-dev.sh](../utils/seed-dev.sh) to rebuild a local dataset, or `utils/deploy/deploy-utils.sh db-clone prod dev` to pull production down.

Note that `src/db/seed.ts` reads `storage/1/1.kml` for its imported sample ride. Storage is gitignored, so on a machine without that file the seed fails at that line; `utils/seed-dev.sh --rides-only` skips it and seeds generated native rides only.

## Baselining a database that predates drizzle/

Prod, stage and both dev machines were built by `push`, so they already have every table in `drizzle/0000_baseline.sql`. Running `migrate` against one of them tries to `CREATE TYPE`/`CREATE TABLE` over the top and fails on the first statement.

[utils/db-baseline.ts](../utils/db-baseline.ts) writes the bookkeeping rows `migrate()` would have written—the same `(hash, created_at)` pairs, read through drizzle's own `readMigrationFiles` so the hashes cannot drift from however the installed version computes them—and runs no schema statements.

**Order matters, and the middle step is the one to not skip:**

1. **Confirm the database actually matches `src/db/schema.ts`.** A baseline records a claim it cannot verify. If the database is behind and you baseline it anyway, the missing columns are now permanently marked as created, and every later migration builds on a shape that is not there. The check is a `drizzle-kit push` against it reporting no changes—that is also how the 2026-08-09 rename was verified. Do this **before** the next deploy switches the hook to `migrate`.
2. **Baseline it once.**

   ```bash
   npm run db:baseline                                  # local
   utils/deploy/deploy-utils.sh db-baseline              # prod or stage, per DEPLOY_ENV
   ```

3. **From then on, `migrate`.** The post-deploy hook already does.

The script refuses two cases outright: a database with no `users` table (that one wants `migrate`, and baselining it would mark a schema created that never was), and a database that already has bookkeeping rows.

This dev machine did not need baselining. Its database was far enough behind—still carrying a `routes` table from before the 2026-08-09 rename to `days`, with one user and no rides—that dropping the schema and running `migrate` from empty was both cheaper and a real test that the baseline migration applies cleanly to a fresh database.

## Deployment

[utils/deploy/hooks/post-deploy.sh](../utils/deploy/hooks/post-deploy.sh) runs `npx drizzle-kit migrate` inside the container and is **fatal on failure**. That is deliberate and predates this change: a non-fatal schema step is how production once drifted three sprints behind and started serving 500s while the deploy reported success. A deploy whose schema step failed has not succeeded.

The image must carry `drizzle/`—see the `COPY drizzle ./drizzle` line in the [Dockerfile](../Dockerfile). Without it `migrate` finds no migrations, applies nothing, and exits 0, which is the same silent drift in a new costume.

## The hand-written SQL in utils/deploy/sql/

[utils/deploy/sql/](../utils/deploy/sql/) holds four dated files that brought production back in line under the `push` workflow—the `routes` → `days` rename, the quota change, and so on. They are **history and stay**: they are the record of what was run against production, and the rename in particular documents a hazard generation still has.

New schema work does not go there. It goes in `drizzle/`.
