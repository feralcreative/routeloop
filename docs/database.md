# Database

`src/db/schema.ts` is the source of truth. This file covers what the tables are for and how a change to them reaches a database.

## The tables

Read `schema.ts` for columns; this is what each one is *for* and the constraints that are not obvious from a type.

- **`users`**—identity, `quota_bytes`, and `used_bytes`, a denormalized cache incremented on import and decremented on delete with no reconciler, so it drifts. The dashboard computes the authoritative sum alongside it and reports the disagreement.
- **`user_identities`**—one row per login method, so a rider can arrive by Google or by magic link and land on the same account. Legacy Google and GitHub identity rows remain valid.
- **`sessions`**—the PK is the SHA-256 hash of the browser token, never the token.
- **`rides`**—`owner_id`, unguessable `slug`, `title`, `description`, `visibility` (public / unlisted / private / friends), `source` (native | imported), `external_url`, the byte columns plus generated `size_bytes`, and the caches `total_miles`, `total_duration_s`, `stop_count`.
- **`days`**—`ride_id`, `position`, `uid` (the day's durable identity, unique per ride), `subgroup_id` (nullable; null means everyone rides it), `title`, `color` (feeds the legend), `start_at`/`end_at` (nullable), `distance_m`, `duration_s`, and the alternates pair `alt_group` (nullable smallint) / `alt_active` (not null, default true). A position, not a calendar date: two days may share a date, and an undated ride still has days.
- **`points`**—`day_id`, `kind` (stop | poi), `position` (the rider's order within the day, NOT NULL for **both** kinds since `0008`, dense from 0), `lat`/`lng`, `name`, `description`, `roles waypoint_role[]` (at most 4, checked by the database), `duration_min` (null means no duration), `dist_from_start_m` (server-computed: the prefix sum of the legs for a stop, a projection onto the track for a POI), `uid` (the point's durable identity). `uq_point_day_pos` is unique over every point in a day; it used to lean on NULLS DISTINCT so that POIs could all carry null. `ck_point_stop_pos` was dropped with `0008`—the NOT NULL says more.
- **`route_legs`**—`day_id`, `position` (leg *i* joins stop *i* to *i+1*), `geometry jsonb` as `[lng,lat][]` at 6 decimals, `distance_m`, `duration_s`, `via_points jsonb` (the ephemeral shaping waypoints).
- **`feedback`**—one submission of any kind: a bug, an idea or a question. The word is *report*; never "ticket", never "issue" (that belongs to GitHub), never "post". Unguessable `public_id` addresses it everywhere a rider or a URL does; `id` is the owner's handle and what `duplicate_of` points at. `body` is the only required field and `title` is derived from it by `titleFrom()`—riders are never asked for one. `want_count` is denormalized and written in the same transaction as the vote rows. **`priority` is owner-only and must never reach a rider-facing surface**: a rider who sees "your bug is P3" is a support incident.
- **`feedback_votes`**—`(feedback_id, user_id)` is the composite primary key, and **that key is the entire anti-fraud mechanism**: one want per rider per report, enforced by Postgres rather than by a check a second code path could forget.
- **`feedback_diagnostics`**—the FK is the PK, one row per report. Its own table because the blob runs 5–50 KB and every board query would otherwise drag it across the wire. `payload jsonb` carries a `$type<>` that Postgres does not enforce, so every read goes through `parseDiagnostics()` and never a cast—the same arrangement as `survey_responses.answers`.
- **`feedback_attachments`**—a rider's screenshot or photo on disk under `STORAGE_PATH/feedback/{report_id}/{n}.{ext}`. **These bytes are counted here and nowhere else.**
- **`ride_members`**—a rider's relationship to a ride: `role` (owner | rider), `rsvp` (invited | going | maybe | declined), `invited_by` (`set null`, so losing the inviter's account does not evict everyone they brought). Unique on (ride, rider); `idx_ride_member_rider` is rider-first because the question is always "is this viewer on this ride". **Schema only as of 2026-08-26**: `canView()` already honors the grant, but nothing in the app inserts a row, so in practice it grants nothing yet.
- **`friendships`**—**one row per pair under a canonical ordering**, `rider_a < rider_b`, enforced by `ck_friendship_order` (which also rules out befriending yourself). Two mirrored rows would make "are these two friends" two lookups that can disagree and two writes to remember. The cost is that the columns no longer imply direction, which is what `requested_by` and `blocked_by` are for—`blocked_by` is load-bearing rather than informational, because only the blocker may lift a block.
- **`ride_subgroups`**—a named set of riders sharing an approach: the Oakland contingent, the Sacramento contingent. Ride, client-minted `uid`, name, color, position. **NOT CHURNED ON SAVE**, unlike every other child of a ride: `ride_members.subgroup_id` and `rides.primary_subgroup_id` point at these rows, so `insertRideGraph` reconciles them by uid—upsert what the payload carries, delete what it does not—which keeps ids stable for as long as the rider keeps the subgroup.
- **`alt_votes`**—one member's pick among a day's alternates. `(ride_id, day_uid, user_id)` is the composite primary key and **that key is the anti-double-vote mechanism**, the same argument `feedback_votes` makes about its own. What it cannot enforce is one vote per alt GROUP, because a group has no durable id: `castVote()` resolves the group from the current days and clears the member's other votes in it, in the same transaction.
- **`user_profiles`**—the FK to `users` *is* the PK, so there is one profile per rider and no surrogate id to keep in sync. Name, address and the geocoded home, the public start place, the sharing toggles and the payment handles. Also `duration_format` and `date_format`, both *display* preferences and not storage ones: `points.duration_min` stays integer minutes and `days.start_at` stays a timestamp whatever they say. **A rider may have no row here at all**, so every reader has to have an answer for that—see `toDurationFormat()` in `src/maps/duration.ts` and `dateFormatFor()` in `src/views/prefs.ts`, and note that the write path upserts rather than updates. That lazy creation is load-bearing for `date_format`: with no row, the format falls back to `Accept-Language`, so an upsert saving some *other* preference must seed `date_format` on INSERT and leave it out of the update set.

**`alt_group` is a within-payload partition key, not a stable id.** Two or more days sharing one non-null `alt_group` are alternatives for the same stretch and exactly one of them has `alt_active`; only that one counts toward `rides.total_miles`, `rides.stop_count` or anything on the dashboard. The value is renumbered densely from 0 on every save, so nothing may store it or join to it—that is forced rather than chosen, because the `PUT` deletes and reinserts every day and no `days.id` survives a save. `src/maps/alts.ts` owns every rule about the pair; `resolveAltGroups()` is total and repairs rather than rejects, because a group of one is what a rider passes through the instant they delete one of a pair. The partial index `uq_day_alt_active` is a tripwire for a bug in that function, not a gate.

**A group member is exactly one day, so a multi-day alternate cannot be expressed.** "Day 3 direct, or days 3b and 3c the long way with an overnight" has no representation here. Decided knowingly on 2026-08-16 in favor of the simpler shape; adding it later means a third `alt_branch` column and a branch filter, not a feature toggle.

**`MAX_DAYS = 31` counts alternates, not just real days.** A 31-day ride therefore cannot carry one. Accepted 2026-08-16 rather than fixed: the cap bounds payload size and insert cost, and excluding losing alternates from it would mean resolving groups before counting instead of checking an array length. A month-long ride wanting alternates is a case that has not come up.

**`feedback.state` and `feedback.status` are two columns on purpose, and collapsing them into one enum is the mistake the pair exists to prevent.** `state` is the owner's gate and controls visibility; `status` is the rider-facing lifecycle. A bug is routinely `fixed` while still `pending`, and there is nothing contradictory about that. **This is also what makes a bug private without a private-bug feature**: nothing is visible to anyone but its author and the owner until it is `published`, and nothing publishes a bug by default. `visibleTo()` in `src/feedback/policy.ts` is the whole mechanism.

**Feedback attachment bytes must stay out of `rides.size_bytes` and `users.used_bytes`.** They are not ride data, they must not eat a rider's 25 MB, and adding a fourth byte column to that generated expression would corrupt quota accounting on every ride delete. `feedback_attachments.bytes` is where they are counted, and it is capped separately.

Enums: `provider`, `visibility`, `ride_role`, `rsvp`, `friendship_status`, `time_anchor`, `ride_source`, `point_kind`, `duration_format`, `date_format`, `waypoint_role`—the 17 roles, which must stay in sync with `src/maps/roles.ts`—and the three feedback enums, `feedback_kind`, `feedback_state` and `feedback_status`. `duration_format` has the same sync requirement against `DURATION_FORMATS` in `src/maps/duration.ts`, and `date_format` against `DATE_FORMATS` in `src/views/date-format.ts`—its members are real BCP-47 tags rather than an abstract order, so Intl supplies the clock convention along with the digit order. **`feedback_status` has one too, and it is enforced:** every member needs a label and a sub-line in `STATUS_META` in `src/feedback/policy.ts`, and `test/feedback-status-labels.test.ts` fails the build if one is added without copy—so the failure is a red test rather than `needs_info` rendered to a rider.

**`days.uid` exists because `days.id` and `alt_group` are both unreferenceable.** The builder's `PUT` deletes and re-inserts every day on every save, so the id churns; `alt_group` is renumbered densely from 0 each time. Voting on an alternate is the first feature needing a day to keep its identity across a save, and this is what it keeps—minted by the client, mirroring `points.uid`. `alt_votes` is keyed `(ride_id, day_uid)` and cascades from **`rides`, not `days`**, exactly as `point_details` does and for the same reason. The flip side is the same too: nothing cleans a vote up when its day leaves the payload, so `reconcileVotes()` does, and `insertRideGraph` calls it.

**`ride_members` is populated at every ride-creating path, and the owner is a member.** `seedOwner()` runs in the same transaction as the ride insert at all four sites, and `drizzle/0015` backfills every ride that predates it. That is what makes "who is on this ride" one question: a reader that has to ask about `rides.owner_id` separately from `ride_members` is a reader that can forget to.

**A SUBGROUP'S APPROACH IS A DAY, NOT A SET OF LEGS.** `days.subgroup_id` nullable, null meaning everyone rides it—which is what every day predating #67 carries, and why that migration needed no backfill. A subgroup owns a SUBSEQUENCE of the ride's positions rather than a numbering of its own, so `uq_day_ride_pos` is untouched and a multi-day approach is simply more days: Seattle takes 0 and 1, San Francisco takes 2, the trunk takes 3. Which days happen on the same calendar day is carried by `start_at`, which already existed. The rejected alternative and why is in `docs/decisions.md`.

**Four `set null` foreign keys hang off `ride_subgroups` and every one is deliberate.** Deleting a subgroup makes its days everyone's, un-groups its riders, and clears the two ride-level pointers—it never destroys a day or throws a rider off a ride. Cascade there would take a rider's planned road away because they renamed a group wrong, which is the `place_groups` call again.

**`rides.primary_subgroup_id` and `rides.trunk_subgroup_id` are two columns although the builder asks once.** Whose clock is pinned and whose route is the spine are the same group when Sacramento joins Oakland's run to the Sierras, and are not the same thing at all when Seattle and San Francisco meet in eastern Oregon—there is no trunk there and the ride starts at the meet. `rides.time_anchor` is a third, independent axis: WHICH event is pinned, not whose.

**`points.slack_min` is not `duration_min`.** Dwell is time everyone spends at a meet; slack is a margin ahead of it that absorbs one group running late. In a planned schedule the two sum, and under two of the three anchors they are indistinguishable—what differs is robustness under delay and what the roadbook tells a rider. `src/subgroups/schedule.ts` states the whole thing precisely.

**`visibility` has four members and their ORDER is not their openness.** `friends` is last because `ALTER TYPE ... ADD VALUE` appends, and a pgEnum's member order is fixed once created—putting it in the "right" place would have meant rebuilding every column using the type. Nothing should read the enum and decide for itself what a member means: `canView()` in `src/access/policy.ts` is the whole rule, `isListed()` says which levels appear in a list nobody asked for by name (only `public`), and `LISTED_RIDE` in `query.ts` is derived from `isListed` rather than restating it. `public` and `unlisted` kept their exact previous meanings when the fourth landed, and `private` gained "and members"—a superset, over a table with no rows, so no existing row changed meaning.

**`rides.size_bytes` is generated as the sum of every byte column.** A column missing from that expression leaks quota on every delete, silently and permanently, because the app increments `used_bytes` on import and the database decrements it from `size_bytes` on delete.

**`route_legs.geometry` is already compressed, and it is not where the space goes.** Measured on the dev database 2026-08-16: 122,647 points across 134 legs, 2,966 kB of raw jsonb text, 1,162 kB actually stored—**TOAST/pglz gets 2.55x with no work**. Storing an encoded polyline instead would win perhaps 2x more, touch every renderer and export, and make the column unqueryable. The uncompressed bytes are the stored originals on disk, which are three times larger and compress 7.2x; see roadmap item 27.

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

3. **From then on, `migrate`.** The deploy's one-shot `migrate` service already does.

The script refuses two cases outright: a database with no `users` table (that one wants `migrate`, and baselining it would mark a schema created that never was), and a database that already has bookkeeping rows.

This dev machine did not need baselining. Its database was far enough behind—still carrying a `routes` table from before the 2026-08-09 rename to `days`, with one user and no rides—that dropping the schema and running `migrate` from empty was both cheaper and a real test that the baseline migration applies cleanly to a fresh database.

## Deployment

[utils/deploy/deploy.sh](../utils/deploy/deploy.sh) runs `npx drizzle-kit migrate` as a one-shot `migrate` service, **before the app container is recreated**, and it is **fatal on failure**. That is deliberate and predates this change: a non-fatal schema step is how production once drifted three sprints behind and started serving 500s while the deploy reported success. A deploy whose schema step failed has not succeeded.

The image must carry `drizzle/`—see the `COPY drizzle ./drizzle` line in the [Dockerfile](../Dockerfile). Without it `migrate` finds no migrations, applies nothing, and exits 0, which is the same silent drift in a new costume.

## The hand-written SQL in utils/deploy/sql/

[utils/deploy/sql/](../utils/deploy/sql/) holds four dated files that brought production back in line under the `push` workflow—the `routes` → `days` rename, the quota change, and so on. They are **history and stay**: they are the record of what was run against production, and the rename in particular documents a hazard generation still has.

New schema work does not go there. It goes in `drizzle/`.
